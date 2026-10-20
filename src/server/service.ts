import { randomUUID } from "node:crypto";
import type { PiWebHostPiSessionsV1, PiWebHostPiSessionEventsV1, PiWebHostPiSessionConnection } from "@jmfederico/pi-web/server-plugin-api";
import { REQUEST, REPLY, MAX_TEXT, MAX_MODEL, record, text, uuid, type Command, type Worker, type Lease } from "../protocol.ts";
import { Store, scopeKey, fingerprint, type Ledger } from "./store.ts";

type Scope = { projectId: string; workspaceId: string };
type Snapshot = Pick<Worker, "status" | "text" | "question" | "model"> & { workerId: string; sequence?: number };
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 1000);
export function parseCommand(input: unknown): Command {
  const c = record(input);
  const base = { requestId: uuid(c.requestId), prompt: text(c.prompt, "prompt") };
  if (c.kind === "start") return { ...base, kind: "start", title: text(c.title, "title", 100), ...(c.model ? { model: text(c.model, "model", MAX_MODEL) } : {}) };
  if (c.kind === "reply" && Number.isSafeInteger(c.expectedRevision) && Number(c.expectedRevision) > 0) return { ...base, kind: "reply", workerId: uuid(c.workerId), expectedRevision: Number(c.expectedRevision) };
  throw new Error("Invalid command");
}
function parseSnapshot(input: unknown): Snapshot {
  const s = record(input);
  if (!["running", "needs-input", "completed", "failed", "unknown"].includes(String(s.status))) throw new Error("Invalid worker status");
  if (typeof s.text !== "string" || s.text.length > MAX_TEXT) throw new Error("Invalid worker text");
  if (!Number.isSafeInteger(s.sequence) || Number(s.sequence) < 0) throw new Error("Invalid companion sequence");
  return { workerId: uuid(s.workerId), sequence: Number(s.sequence), status: s.status as Snapshot["status"], text: s.text, model: typeof s.model === "string" && s.model.length <= MAX_MODEL ? s.model : "default", ...(s.question ? { question: text(s.question, "question", MAX_TEXT) } : {}) };
}

/** Durable admission, exact session correlation, no automatic mutation retries. */
export class VoiceService {
  private queue: Promise<unknown> = Promise.resolve();
  private leases = new Map<string, Lease>();
  private connections = new Map<string, PiWebHostPiSessionConnection>();
  private ledgers = new Map<string, Ledger>();
  private disposed = false;
  private persistenceError = "";
  private tasks = new Set<Promise<void>>();
  constructor(private store: Store, private sessions: PiWebHostPiSessionsV1, private events: PiWebHostPiSessionEventsV1, private lifetime: AbortSignal) {}
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.queue.then(fn);
    this.queue = result.catch(() => {});
    return result;
  }
  private async ledger(scope: Scope): Promise<Ledger> {
    const key = scopeKey(scope.projectId, scope.workspaceId);
    let value = this.ledgers.get(key);
    if (!value) {
      value = await this.store.load(key);
      for (const worker of value.workers) {
        if (["starting", "running"].includes(worker.status)) worker.text = "Backend restarted. Work may continue; inspect the exact session or refresh to reconcile.";
        worker.status = "unknown";
        delete worker.companionSequence;
        worker.revision++;
      }
      this.ledgers.set(key, value);
    }
    return value;
  }
  private async save(scope: Scope, ledger: Ledger) {
    try { await this.store.save(scopeKey(scope.projectId, scope.workspaceId), ledger); }
    catch (error) { this.persistenceError = `Voice storage failed; further instructions blocked until backend recovery: ${errorText(error)}`; throw error; }
  }
  arm(scope: Scope, count: unknown): Lease {
    this.lifetime.throwIfAborted();
    if (count !== 1 && count !== 3) throw new Error("Allowance must be one or three instructions");
    const value = { token: randomUUID(), remaining: count, expiresAt: Date.now() + 10 * 60_000 };
    this.leases.set(scopeKey(scope.projectId, scope.workspaceId), value);
    return { ...value };
  }
  disarm(scope: Scope, token?: unknown) {
    const key = scopeKey(scope.projectId, scope.workspaceId);
    if (token === undefined || this.leases.get(key)?.token === token) this.leases.delete(key);
  }
  async list(scope: Scope): Promise<Worker[]> {
    const workers = await this.serial(async () => structuredClone((await this.ledger(scope)).workers));
    // Reconcile only already-hosted conversations. Public connect never opens saved sessions.
    await Promise.all(workers.filter(w => w.sessionId).map(async w => {
      try {
        const connection = await this.connect(scope, w);
        const result = await this.rpc(connection, { operation: "status", workerId: w.id });
        if (result.snapshot) await this.update(scope, w.id, parseSnapshot(result.snapshot), connection);
      } catch { /* Unknown stays unknown. A transport failure is not completion. */ }
    }));
    return this.serial(async () => structuredClone((await this.ledger(scope)).workers));
  }
  async models(scope: Scope, sessionId: unknown) {
    const connection = await this.events.connect({ ...scope, sessionId: text(sessionId, "session ID", 512) });
    try {
      const response = await this.rpc(connection, { operation: "models" });
      if (!Array.isArray(response.models)) throw new Error("Invalid model catalog");
      return response.models.map(value => { const m = record(value); return { id: text(m.id, "model ID", MAX_MODEL), name: text(m.name, "model name", MAX_MODEL) }; });
    } finally { connection.close(); }
  }
  async execute(scope: Scope, input: unknown): Promise<Worker> {
    const data = record(input);
    const command = parseCommand(data.command);
    return this.serial(async () => {
      this.lifetime.throwIfAborted();
      if (this.disposed) throw new Error("Voice backend disposed");
      if (this.persistenceError) throw new Error(this.persistenceError);
      const ledger = await this.ledger(scope);
      const hash = fingerprint(command);
      const receipt = ledger.receipts.find(r => r.requestId === command.requestId);
      if (receipt) {
        if (receipt.fingerprint !== hash) throw new Error("Request ID reused with different instruction");
        return structuredClone(ledger.workers.find(w => w.id === receipt.workerId)!);
      }
      const lease = this.leases.get(scopeKey(scope.projectId, scope.workspaceId));
      if (!lease || lease.token !== data.token || lease.expiresAt <= Date.now() || lease.remaining < 1) throw new Error("Approve this instruction or arm a fresh allowance first");
      if (ledger.receipts.length >= 1000 || (command.kind === "start" && ledger.workers.length >= 30)) throw new Error("Voice ledger capacity reached; archive it offline before admitting more work");
      let worker: Worker;
      if (command.kind === "reply") {
        const found = ledger.workers.find(w => w.id === command.workerId);
        if (!found || !found.sessionId) throw new Error("Unknown worker");
        if (found.revision !== command.expectedRevision) throw new Error("Worker changed; refresh before replying");
        if (!["needs-input", "completed", "failed"].includes(found.status)) throw new Error("Worker is busy or its state is unknown; inspect session first");
        worker = found;
        worker.status = "starting";
        worker.text = "Follow-up admitted; delivery pending.";
        delete worker.question;
        worker.revision++;
        worker.updatedAt = new Date().toISOString();
      } else {
        if (ledger.workers.filter(w => ["starting", "running", "unknown"].includes(w.status)).length >= 3) throw new Error("At most three active or uncertain workers per workspace");
        worker = { id: command.requestId, ...scope, sessionId: "", title: command.title!, model: command.model ?? "default", status: "starting", text: "Instruction admitted; session creation pending.", revision: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
        ledger.workers.push(worker);
      }
      lease.remaining--;
      ledger.receipts.push({ requestId: command.requestId, fingerprint: hash, workerId: worker.id });
      // Never start side effects until admission is durable. A failed save leaves the
      // in-memory receipt uncertain and blocks duplicate execution in this process.
      await this.save(scope, ledger);
      const task = this.dispatch(scope, structuredClone(worker), command).catch(() => {});
      this.tasks.add(task);
      void task.finally(() => this.tasks.delete(task));
      return structuredClone(worker);
    });
  }
  private async dispatch(scope: Scope, worker: Worker, command: Command) {
    try {
      this.lifetime.throwIfAborted();
      if (!worker.sessionId) {
        const created = await this.sessions.create(scope);
        worker.sessionId = created.sessionId;
        await this.serial(async () => {
          const ledger = await this.ledger(scope);
          const saved = ledger.workers.find(w => w.id === worker.id)!;
          saved.sessionId = created.sessionId;
          saved.updatedAt = new Date().toISOString();
          await this.save(scope, ledger);
        });
      }
      const connection = await this.connect(scope, worker);
      const response = await this.rpc(connection, { operation: command.kind, workerId: worker.id, prompt: command.prompt, ...(command.title ? { title: command.title } : {}), ...(command.model ? { model: command.model } : {}), ...(command.kind === "reply" ? { expectedSequence: worker.companionSequence } : {}) }, command.requestId);
      if (response.snapshot) await this.update(scope, worker.id, parseSnapshot(response.snapshot), connection);
    } catch (error) {
      await this.update(scope, worker.id, { workerId: worker.id, status: "unknown", model: worker.model, text: `Delivery or tracking uncertain: ${errorText(error)}. Inspect Sessions before retrying; work was not cancelled.` });
    }
  }
  private async connect(scope: Scope, worker: Worker) {
    const key = `${scopeKey(scope.projectId, scope.workspaceId)}:${worker.id}`;
    const existing = this.connections.get(key);
    if (existing && !existing.signal.aborted) return existing;
    const connection = await this.events.connect({ ...scope, sessionId: worker.sessionId });
    if (this.disposed) { connection.close(); throw new Error("Voice disposed"); }
    const raced = this.connections.get(key);
    if (raced && !raced.signal.aborted) { connection.close(); return raced; }
    this.connections.set(key, connection);
    connection.on(REPLY, data => {
      try {
        const value = record(data);
        if (!value.snapshot) return;
        const snapshot = parseSnapshot(value.snapshot);
        if (snapshot.workerId !== worker.id) return;
        // A reply to an earlier bounded RPC must not overwrite a newer async snapshot.
        if (value.requestId) return;
        void this.update(scope, worker.id, snapshot, connection).catch(() => {});
      } catch { /* Ignore unrelated or malformed bus events. */ }
    });
    connection.signal.addEventListener("abort", () => {
      if (this.connections.get(key) === connection) this.connections.delete(key);
      void this.serial(async () => {
        const ledger = await this.ledger(scope);
        const saved = ledger.workers.find(w => w.id === worker.id);
        if (saved) {
          if (["starting", "running"].includes(saved.status)) saved.text = "Session event connection closed. Work may continue; inspect Sessions.";
          saved.status = "unknown"; delete saved.companionSequence; saved.revision++;
          await this.save(scope, ledger);
        }
      }).catch(() => {});
    }, { once: true });
    return connection;
  }
  private update(scope: Scope, workerId: string, snapshot: Snapshot, connection?: PiWebHostPiSessionConnection) {
    return this.serial(async () => {
      if (connection?.signal.aborted) return;
      const ledger = await this.ledger(scope);
      const worker = ledger.workers.find(w => w.id === workerId);
      if (!worker || snapshot.workerId !== workerId) return;
      if (snapshot.sequence === undefined && !["starting", "running", "unknown"].includes(worker.status)) return;
      if (snapshot.sequence !== undefined && snapshot.sequence <= (worker.companionSequence ?? -1)) return;
      if (snapshot.sequence !== undefined) worker.companionSequence = snapshot.sequence;
      if (snapshot.sequence === undefined && worker.status === snapshot.status && worker.text === snapshot.text && worker.question === snapshot.question && worker.model === snapshot.model) return;
      Object.assign(worker, { status: snapshot.status, text: snapshot.text, model: snapshot.model, updatedAt: new Date().toISOString(), revision: worker.revision + 1 });
      if (snapshot.question) worker.question = snapshot.question; else delete worker.question;
      await this.save(scope, ledger);
    });
  }
  private rpc(connection: PiWebHostPiSessionConnection, payload: Record<string, unknown>, requestId: string = randomUUID()): Promise<Record<string, unknown>> {
    const signal = AbortSignal.any([connection.signal, this.lifetime]);
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      let unsubscribe = () => {};
      const finish = (error?: Error, value?: Record<string, unknown>) => { clearTimeout(timer); unsubscribe(); signal.removeEventListener("abort", abort); error ? reject(error) : resolve(value!); };
      const abort = () => finish(new Error("Session connection interrupted"));
      const timer = setTimeout(() => finish(new Error("No companion receipt in five seconds; check extension enablement")), 5000);
      signal.addEventListener("abort", abort, { once: true });
      unsubscribe = connection.on(REPLY, input => {
        try {
          const value = record(input);
          if (value.requestId !== requestId) return;
          if (value.ok !== true) finish(new Error(typeof value.error === "string" ? value.error.slice(0, 1000) : "Companion rejected request"));
          else finish(undefined, value);
        } catch { /* Ignore malformed bus traffic. */ }
      });
      try { connection.emit(REQUEST, { ...payload, requestId }); } catch (error) { finish(new Error(errorText(error))); }
    });
  }
  async dispose() {
    this.disposed = true;
    this.leases.clear();
    for (const connection of this.connections.values()) connection.close();
    this.connections.clear();
    await this.queue; // Admissions may still register dispatch tasks after their durable save.
    await Promise.all([...this.tasks]);
    await this.queue; // Drain final uncertainty writes from dispatch/connection cleanup.
  }
}

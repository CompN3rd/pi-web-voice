import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { VoiceService, parseCommand } from "../src/server/service.ts";
import { Store, scopeKey } from "../src/server/store.ts";
import { REPLY } from "../src/protocol.ts";

const scope = { projectId: "project", workspaceId: "workspace" };
const command = () => ({ requestId: randomUUID(), kind: "start", title: "Test worker", prompt: "Inspect tests" });
async function fixture(t: any) {
  const directory = await mkdtemp(join(tmpdir(), "pi-voice-test-"));
  const store = new Store(directory);
  const lifetime = new AbortController();
  let creates = 0, prompts = 0;
  let snapshot: any;
  const listeners = new Set<(x: any) => void>();
  const connectionLifetime = new AbortController();
  const emit = (value: any) => { for (const listener of [...listeners]) listener(value); };
  const connection = {
    signal: connectionLifetime.signal,
    on(_name: string, listener: (x: any) => void) { listeners.add(listener); return () => listeners.delete(listener); },
    emit(_name: string, input: any) {
      if (input.operation === "start" || input.operation === "reply") {
        prompts++; snapshot = { workerId: input.workerId, status: "running", text: "", model: "test/model", sequence: (snapshot?.sequence ?? 0) + 1 };
        emit({ snapshot });
      }
      emit({ requestId: input.requestId, ok: true, snapshot });
    },
    close() { connectionLifetime.abort(); },
  };
  const sessions = { version: 1 as const, async create() { creates++; return { sessionId: `session-${creates}` }; }, async run() { throw new Error("unused"); } };
  const events = { version: 1 as const, async connect() { return connection; } };
  const service = new VoiceService(store, sessions, events, lifetime.signal);
  t.after(async () => { lifetime.abort(); await service.dispose(); await rm(directory, { recursive: true, force: true }); });
  return { service, store, sessions, events, lifetime, get creates() { return creates; }, get prompts() { return prompts; }, emit, setSnapshot(value: any) { snapshot = value; } };
}
async function settle(service: VoiceService) { await new Promise(r => setImmediate(r)); return service.list(scope); }

test("disposal drains admission and its later uncertainty persistence before resolving", async t => {
  const f = await fixture(t);
  const save = f.store.save.bind(f.store);
  let releaseAdmission!: () => void, releaseUnknown!: () => void;
  const admissionGate = new Promise<void>(r => { releaseAdmission = r; });
  const unknownGate = new Promise<void>(r => { releaseUnknown = r; });
  let signalAdmission!: () => void, signalUnknown!: () => void;
  const admissionReached = new Promise<void>(r => { signalAdmission = r; });
  const unknownReached = new Promise<void>(r => { signalUnknown = r; });
  let saves = 0;
  f.store.save = async (key, ledger) => {
    if (++saves === 1) { signalAdmission(); await admissionGate; }
    else if (saves === 2) { signalUnknown(); await unknownGate; }
    await save(key, ledger);
  };
  const lease = f.service.arm(scope, 1);
  const admission = f.service.execute(scope, { command: command(), token: lease.token });
  await admissionReached; f.lifetime.abort();
  let disposed = false;
  const disposal = f.service.dispose().then(() => { disposed = true; });
  releaseAdmission(); await admission; await unknownReached;
  assert.equal(disposed, false);
  releaseUnknown(); await disposal;
  assert.equal(disposed, true); assert.equal(f.creates, 0);
});
test("validates commands and rejects malformed revisions", () => {
  assert.throws(() => parseCommand({ ...command(), requestId: "short" }));
  assert.throws(() => parseCommand({ kind: "reply", requestId: randomUUID(), workerId: randomUUID(), prompt: "yes", expectedRevision: -1 }));
  assert.equal(parseCommand(command()).kind, "start");
});
test("requires explicit scoped allowance; records admission before starting", async t => {
  const f = await fixture(t); const c = command();
  await assert.rejects(f.service.execute(scope, { command: c, token: "no" }), /Approve/);
  assert.equal(f.creates, 0);
  const lease = f.service.arm(scope, 1);
  const worker = await f.service.execute(scope, { command: c, token: lease.token });
  assert.equal(worker.status, "starting");
  const ledger = await f.store.load(scopeKey(scope.projectId, scope.workspaceId));
  assert.equal(ledger.receipts[0].requestId, c.requestId);
  const workers = await settle(f.service);
  assert.equal(workers[0].status, "running"); assert.equal(f.prompts, 1);
});
test("deduplicates accepted instructions even after allowance consumed; rejects changed payload", async t => {
  const f = await fixture(t); const c = command(); const lease = f.service.arm(scope, 1);
  await Promise.all([f.service.execute(scope, { command: c, token: lease.token }), f.service.execute(scope, { command: c, token: lease.token })]);
  await settle(f.service); assert.equal(f.creates, 1); assert.equal(f.prompts, 1);
  await assert.rejects(f.service.execute(scope, { command: { ...c, prompt: "other" }, token: lease.token }), /reused/);
  await assert.rejects(f.service.execute(scope, { command: command(), token: lease.token }), /Approve/);
});
test("late token-specific revocation cannot revoke a newer explicit allowance", async t => {
  const f = await fixture(t);
  const old = f.service.arm(scope, 1), current = f.service.arm(scope, 1);
  f.service.disarm(scope, old.token);
  await f.service.execute(scope, { command: command(), token: current.token });
  await settle(f.service); assert.equal(f.creates, 1);
});
test("allowance does not cross workspaces and revoke blocks new work", async t => {
  const f = await fixture(t); const lease = f.service.arm(scope, 3);
  await assert.rejects(f.service.execute({ ...scope, workspaceId: "other" }, { command: command(), token: lease.token }), /Approve/);
  f.service.disarm(scope);
  await assert.rejects(f.service.execute(scope, { command: command(), token: lease.token }), /Approve/);
});
test("only correlated newer companion snapshots update status", async t => {
  const f = await fixture(t); const c = command(); const lease = f.service.arm(scope, 1);
  await f.service.execute(scope, { command: c, token: lease.token }); await settle(f.service);
  const done = { workerId: c.requestId, status: "completed", text: "Tests pass", model: "test/model", sequence: 3 };
  f.setSnapshot(done); f.emit({ snapshot: done });
  f.emit({ snapshot: { ...done, sequence: 2, status: "running", text: "stale" } });
  f.emit({ snapshot: { ...done, sequence: 4, workerId: randomUUID(), text: "wrong" } });
  const [worker] = await settle(f.service);
  assert.equal(worker.status, "completed"); assert.equal(worker.text, "Tests pass");
});
test("follow-up requires exact worker revision and settled status", async t => {
  const f = await fixture(t); const c = command(); const lease = f.service.arm(scope, 3);
  await f.service.execute(scope, { command: c, token: lease.token }); let [worker] = await settle(f.service);
  const reply = { requestId: randomUUID(), kind: "reply", workerId: worker.id, expectedRevision: worker.revision, prompt: "Continue" };
  await assert.rejects(f.service.execute(scope, { command: reply, token: lease.token }), /busy/);
  const waiting = { workerId: c.requestId, status: "needs-input", text: "", question: "Which target?", model: "test/model", sequence: 3 };
  f.setSnapshot(waiting); f.emit({ snapshot: waiting }); [worker] = await settle(f.service);
  await assert.rejects(f.service.execute(scope, { command: reply, token: lease.token }), /changed/);
  await f.service.execute(scope, { command: { ...reply, expectedRevision: worker.revision }, token: lease.token });
  await settle(f.service); assert.equal(f.prompts, 2); assert.equal(f.creates, 1);
});
test("restart retains identity but never restarts unknown work", async t => {
  const f = await fixture(t); const c = command(); const lease = f.service.arm(scope, 1);
  await f.service.execute(scope, { command: c, token: lease.token }); await settle(f.service);
  const restarted = new VoiceService(f.store, f.sessions, { version: 1, async connect() { throw new Error("not hosted"); } }, f.lifetime.signal);
  t.after(() => restarted.dispose());
  const [worker] = await restarted.list(scope);
  assert.equal(worker.status, "unknown"); assert.equal(worker.sessionId, "session-1"); assert.equal(f.creates, 1);
});
test("storage failure blocks admission and does not dispatch", async t => {
  const f = await fixture(t); f.store.save = async () => { throw new Error("disk full"); };
  const lease = f.service.arm(scope, 3); const c = command();
  await assert.rejects(f.service.execute(scope, { command: c, token: lease.token }), /disk full/);
  await assert.rejects(f.service.execute(scope, { command: c, token: lease.token }), /storage failed/);
  assert.equal(f.creates, 0);
});

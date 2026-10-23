import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { VoiceService, parseCommand } from "../src/server/service.ts";
import { Store, scopeKey } from "../src/server/store.ts";
import { MAX_MODEL, MAX_TEXT, REQUEST, REPLY } from "../src/protocol.ts";

const scope = { projectId: "project", workspaceId: "workspace" };
const command = () => ({ requestId: randomUUID(), kind: "start", title: "Test worker", prompt: "Inspect tests" });
async function fixture(t: any) {
  const directory = await mkdtemp(join(tmpdir(), "pi-voice-test-"));
  const store = new Store(directory);
  const lifetime = new AbortController();
  let creates = 0, prompts = 0;
  let snapshot: any;
  const listeners = new Set<(x: any) => void>();
  const emit = (value: any) => { for (const listener of [...listeners]) listener(value); };
  const sessions = { version: 1 as const, async create() { creates++; return { sessionId: `session-${creates}` }; }, async run() { throw new Error("unused"); } };
  const events = { version: 1 as const, async connect() {
    const connectionLifetime = new AbortController();
    const ownedListeners = new Set<(data: any) => void>();
    return {
      signal: connectionLifetime.signal,
      on(name: string, listener: (data: any) => void) {
        assert.equal(name, REPLY);
        listeners.add(listener); ownedListeners.add(listener);
        return () => { listeners.delete(listener); ownedListeners.delete(listener); };
      },
      emit(name: string, input: any) {
        assert.equal(name, REQUEST);
        if (input.operation === "start" || input.operation === "reply") {
          prompts++; snapshot = { workerId: input.workerId, status: "running", text: "", model: "test/model", sequence: (snapshot?.sequence ?? 0) + 1 };
          emit({ snapshot });
        }
        emit({ requestId: input.requestId, ok: true, snapshot });
      },
      close() {
        connectionLifetime.abort();
        for (const listener of ownedListeners) listeners.delete(listener);
        ownedListeners.clear();
      },
    };
  } };
  const service = new VoiceService(store, sessions, events, lifetime.signal);
  t.after(async () => { lifetime.abort(); await service.dispose(); await rm(directory, { recursive: true, force: true }); });
  return { service, store, sessions, events, lifetime, get creates() { return creates; }, get prompts() { return prompts; }, emit, setSnapshot(value: any) { snapshot = value; } };
}
async function settle(service: VoiceService) { await new Promise(r => setImmediate(r)); return service.list(scope); }

test("host fixture connections own independent lifetimes and subscriptions", async t => {
  const f = await fixture(t);
  const first = await f.events.connect(), second = await f.events.connect();
  t.after(() => { first.close(); second.close(); });
  let firstReplies = 0, secondReplies = 0;
  first.on(REPLY, () => { firstReplies++; });
  second.on(REPLY, () => { secondReplies++; });
  first.close();
  assert.equal(second.signal.aborted, false);
  f.emit({});
  assert.equal(firstReplies, 0);
  assert.equal(secondReplies, 1);
  second.close();
  f.emit({});
  assert.equal(secondReplies, 1);
});

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
test("disposal blocks a durably pending admission without requiring a host lifetime abort", async t => {
  const f = await fixture(t);
  const save = f.store.save.bind(f.store);
  let release!: () => void, reached!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const saving = new Promise<void>(resolve => { reached = resolve; });
  let first = true;
  f.store.save = async (key, ledger) => {
    if (first) { first = false; reached(); await gate; }
    await save(key, ledger);
  };
  const c = command();
  const lease = f.service.arm(scope, 1);
  const admission = f.service.execute(scope, { command: c, token: lease.token });
  await saving;
  const disposal = f.service.dispose();
  release(); await admission; await disposal;
  assert.equal(f.lifetime.signal.aborted, false);
  assert.equal(f.creates, 0);
  assert.equal(f.prompts, 0);
  const ledger = await f.store.load(scopeKey(scope.projectId, scope.workspaceId));
  assert.equal(ledger.workers[0].status, "unknown");
  assert.equal(ledger.receipts[0].requestId, c.requestId);
});

test("disposed service rejects new allowances, reads and catalogs before connecting", async t => {
  const f = await fixture(t);
  let connects = 0;
  f.events.connect = async () => { connects++; throw new Error("Must not connect after disposal"); };
  await f.service.dispose();
  assert.throws(() => f.service.arm(scope, 1), /disposed/i);
  await assert.rejects(f.service.list(scope), /disposed/i);
  await assert.rejects(f.service.models(scope, "session"), /disposed/i);
  await assert.rejects(f.service.execute(scope, { command: command(), token: "expired" }), /disposed/i);
  assert.equal(connects, 0);
});

test("model catalog connection resolving after disposal is closed without emitting a request", async t => {
  const f = await fixture(t);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let closes = 0, emits = 0;
  const connectionLifetime = new AbortController();
  const listeners = new Set<(data: any) => void>();
  f.events.connect = async () => {
    await gate;
    return {
      signal: connectionLifetime.signal,
      on(name: string, listener: (data: any) => void) {
        assert.equal(name, REPLY);
        listeners.add(listener); return () => listeners.delete(listener);
      },
      emit(name: string, input: any) {
        assert.equal(name, REQUEST); emits++;
        for (const listener of [...listeners]) listener({ requestId: input.requestId, ok: true, models: [] });
      },
      close() { closes++; connectionLifetime.abort(); },
    };
  };
  const catalog = f.service.models(scope, "session");
  await f.service.dispose();
  release();
  await assert.rejects(catalog, /disposed/i);
  assert.equal(emits, 0);
  assert.equal(closes, 1);
  assert.equal(listeners.size, 0);
});

test("disposal interrupts an outstanding model RPC and closes its temporary connection", async t => {
  const f = await fixture(t);
  const connection = await f.events.connect();
  let requested!: () => void;
  const emitted = new Promise<void>(resolve => { requested = resolve; });
  connection.emit = () => { requested(); };
  let closes = 0;
  const close = connection.close.bind(connection);
  connection.close = () => { closes++; close(); };
  f.events.connect = async () => connection;
  const catalog = f.service.models(scope, "session");
  const rejected = assert.rejects(catalog, /interrupted/);
  await emitted;
  await f.service.dispose();
  await rejected;
  assert.equal(closes, 1);
  assert.equal(connection.signal.aborted, true);
});

test("creation already in flight at disposal retains its exact identity without kickoff", async t => {
  const f = await fixture(t);
  const create = f.sessions.create.bind(f.sessions);
  let release!: () => void, requested!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const creating = new Promise<void>(resolve => { requested = resolve; });
  f.sessions.create = async () => { requested(); await gate; return create(); };
  let connects = 0;
  f.events.connect = async () => { connects++; throw new Error("Must not connect after disposal"); };
  const c = command();
  const lease = f.service.arm(scope, 1);
  await f.service.execute(scope, { command: c, token: lease.token });
  await creating;
  const disposal = f.service.dispose();
  release(); await disposal;
  const ledger = await f.store.load(scopeKey(scope.projectId, scope.workspaceId));
  assert.equal(ledger.workers[0].sessionId, "session-1");
  assert.equal(ledger.workers[0].status, "unknown");
  assert.equal(f.creates, 1);
  assert.equal(connects, 0);
  assert.equal(f.prompts, 0);
});

test("validates commands and rejects malformed revisions", () => {
  assert.throws(() => parseCommand({ ...command(), requestId: "short" }));
  assert.throws(() => parseCommand({ kind: "reply", requestId: randomUUID(), workerId: randomUUID(), prompt: "yes", expectedRevision: -1 }));
  assert.equal(parseCommand(command()).kind, "start");
});
test("invalid explicit models reject before admission rather than selecting the default", async t => {
  const f = await fixture(t);
  const c = command();
  const lease = f.service.arm(scope, 1);
  for (const model of [false, 0, null, "", "   ", [], {}, "x".repeat(MAX_MODEL + 1)]) {
    await assert.rejects(f.service.execute(scope, { command: { ...c, model }, token: lease.token }), /Invalid model/);
  }
  assert.equal(f.creates, 0);
  assert.equal(f.prompts, 0);
  assert.deepEqual((await f.store.load(scopeKey(scope.projectId, scope.workspaceId))).receipts, []);
  assert.equal(parseCommand({ ...c, model: "test/model" }).model, "test/model");
  assert.equal(parseCommand(c).model, undefined);
  // Rejections must not consume the allowance or reserve the request ID.
  await f.service.execute(scope, { command: c, token: lease.token });
  await settle(f.service);
  assert.equal(f.creates, 1);
  assert.equal(f.prompts, 1);
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
  assert.equal(workers[0].status, "running", JSON.stringify(workers[0])); assert.equal(f.prompts, 1);
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
test("malformed snapshots cannot mutate workers or poison sequence fences", async t => {
  const f = await fixture(t);
  const c = command();
  const lease = f.service.arm(scope, 1);
  await f.service.execute(scope, { command: c, token: lease.token });
  const [before] = await settle(f.service);
  const base = { workerId: c.requestId, status: "completed", text: "Result", model: "test/model", sequence: 1000 };
  const invalid = [
    { status: ["completed"] }, { status: ["running"] }, { status: ["unknown"] }, { status: null },
    { model: undefined }, { model: false }, { model: 0 }, { model: null }, { model: [] }, { model: "x".repeat(MAX_MODEL + 1) },
    { question: false }, { question: 0 }, { question: null }, { question: "" }, { question: [] }, { question: "x".repeat(MAX_TEXT + 1) },
    { text: 42 }, { text: "x".repeat(MAX_TEXT + 1) },
  ];
  for (const patch of invalid) {
    const snapshot = { ...base, ...patch };
    f.setSnapshot(snapshot); f.emit({ snapshot });
    // Exercise both unsolicited events and correlated status-RPC replies.
    const [actual] = await settle(f.service);
    assert.deepEqual(actual, before);
  }
  const done = { ...base, sequence: before.companionSequence! + 1 };
  f.setSnapshot(done); f.emit({ snapshot: done });
  const [after] = await settle(f.service);
  assert.equal(after.status, "completed");
  assert.equal(after.model, "test/model");
  assert.equal(after.companionSequence, done.sequence);
  // The companion's unmarked-worker response legitimately uses an empty model ID.
  const unmarked = { ...done, status: "unknown", model: "", sequence: done.sequence + 1 };
  f.setSnapshot(unmarked); f.emit({ snapshot: unmarked });
  const [unknown] = await settle(f.service);
  assert.equal(unknown.status, "unknown");
  assert.equal(unknown.model, "");
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
test("follow-ups share the active-worker limit without consuming rejected admissions", async t => {
  const f = await fixture(t);
  const start = async () => {
    const c = command();
    const lease = f.service.arm(scope, 1);
    await f.service.execute(scope, { command: c, token: lease.token });
    await settle(f.service);
    return c;
  };
  const target = await start();
  const publish = async (workerId: string, status: string, sequence: number) => {
    const snapshot = { workerId, status, sequence, text: "", model: "test/model" };
    f.setSnapshot(snapshot); f.emit({ snapshot });
    return settle(f.service);
  };
  const [settled] = await publish(target.requestId, "completed", 100);
  const firstActive = await start();
  await start(); await start();
  assert.equal(f.creates, 4);
  assert.equal(f.prompts, 4);
  const reply = { kind: "reply", requestId: randomUUID(), workerId: target.requestId, expectedRevision: settled.revision, prompt: "Follow up" };
  const lease = f.service.arm(scope, 1);
  const attempt = () => f.service.execute(scope, { command: reply, token: lease.token });
  await assert.rejects(attempt(), /At most three active or uncertain/);
  // Uncertain workers retain their capacity slot; they cannot make a retry safe.
  await publish(firstActive.requestId, "unknown", 1000);
  await assert.rejects(attempt(), /At most three active or uncertain/);
  const before = await f.store.load(scopeKey(scope.projectId, scope.workspaceId));
  assert.equal(before.receipts.length, 4);
  assert.equal(before.workers.find(w => w.id === target.requestId)!.status, "completed");
  assert.equal(f.prompts, 4);
  // A known settlement frees a slot. The same allowance still has its one instruction.
  await publish(firstActive.requestId, "completed", 1001);
  await attempt();
  const workers = await settle(f.service);
  assert.equal(workers.filter(w => ["starting", "running", "unknown"].includes(w.status)).length, 3);
  assert.equal(f.creates, 4);
  assert.equal(f.prompts, 5);
  // Deduplication must remain ahead of both the capacity and consumed-allowance checks.
  await attempt(); await settle(f.service);
  assert.equal(f.prompts, 5);
  const after = await f.store.load(scopeKey(scope.projectId, scope.workspaceId));
  assert.equal(after.receipts.length, 5);
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

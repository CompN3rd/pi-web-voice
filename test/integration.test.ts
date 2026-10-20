import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import companion from "../src/companion.ts";
import { VoiceService } from "../src/server/service.ts";
import { Store } from "../src/server/store.ts";

/** Actual companion and service joined by an in-memory native event bus. No model/host process. */
async function integration(t: any) {
  const directory = await mkdtemp(join(tmpdir(), "voice-interop-"));
  const lifetime = new AbortController();
  const listeners = new Map<string, Set<(value: any) => unknown>>();
  const on = (name: string, fn: (value: any) => unknown) => { const set = listeners.get(name) ?? new Set(); set.add(fn); listeners.set(name, set); return () => set.delete(fn); };
  const emit = (name: string, value: any) => { for (const fn of [...(listeners.get(name) ?? [])]) void fn(value); };
  const handlers = new Map<string, Function>();
  const tools = new Map<string, any>();
  const entries: any[] = [];
  let branch = entries;
  const prompts: string[] = [];
  const model = { provider: "test", id: "model", name: "Model" };
  const context = { model, isIdle: () => true, hasPendingMessages: () => false, modelRegistry: { getAvailable: () => [model] }, sessionManager: { getBranch: () => branch, getEntries: () => entries, getSessionId: () => "interop-session" } } as unknown as ExtensionContext;
  companion({ on: (name: string, fn: Function) => handlers.set(name, fn), events: { on, emit }, registerTool: (tool: any) => tools.set(tool.name, tool), appendEntry: (customType: string, data: any) => { const entry = { type: "custom", customType, data: structuredClone(data) }; entries.push(entry); if (branch !== entries) branch.push(entry); }, setSessionName() {}, setModel: async () => true, sendUserMessage: (prompt: string) => { prompts.push(prompt); } } as unknown as ExtensionAPI);
  const event = (name: string, value: any = {}) => handlers.get(name)?.({ type: name, ...value }, context);
  const connections: AbortController[] = [];
  const events = { version: 1 as const, async connect() { const ctrl = new AbortController(); connections.push(ctrl); const stops: (() => void)[] = []; return { signal: ctrl.signal, on: (name: string, fn: (v: unknown) => void | Promise<void>) => { const stop = on(name, fn); stops.push(stop); return stop; }, emit, close() { for (const stop of stops) stop(); ctrl.abort(); } }; } };
  const sessions = { version: 1 as const, async create() { await event("session_start"); return { sessionId: "interop-session" }; }, async run(): Promise<never> { throw new Error("unused"); } };
  const store = new Store(directory);
  let service = new VoiceService(store, sessions, events, lifetime.signal);
  t.after(async () => { lifetime.abort(); await service.dispose(); await event("session_shutdown"); await rm(directory, { recursive: true, force: true }); });
  const scope = { projectId: "p", workspaceId: "w" };
  const start = async () => {
    const lease = service.arm(scope, 3);
    const worker = await service.execute(scope, { token: lease.token, command: { requestId: randomUUID(), kind: "start", title: "Interop", prompt: "Task" } });
    await new Promise(r => setImmediate(r)); await service.list(scope);
    return { worker, lease };
  };
  const begin = async () => { await event("before_agent_start", { messageType: "user", prompt: prompts.at(-1) }); await event("message_start", { message: { role: "user", content: prompts.at(-1) } }); };
  const finish = async () => { await event("message_end", { message: { role: "assistant", content: [{ type: "text", text: "Done" }], stopReason: "stop" } }); await event("agent_settled", { aborted: false }); };
  return { get service() { return service; }, scope, start, begin, finish, event, entries, prompts,
    question: (question: string) => tools.get("voice_request_input").execute("q", { question }, undefined, undefined, context),
    async branchTo(saved: any[]) { branch = saved; await event("session_tree"); },
    async restart() { await service.dispose(); service = new VoiceService(store, sessions, events, lifetime.signal); },
  };
}

test("actual companion and service round-trip a 4001-character question and answer", async t => {
  const f = await integration(t); const { lease } = await f.start(); await f.begin();
  await f.question("x".repeat(4001)); await f.event("agent_settled", { aborted: false });
  const [worker] = await f.service.list(f.scope);
  assert.equal(worker.status, "needs-input"); assert.equal(worker.question?.length, 4001);
  await f.service.execute(f.scope, { token: lease.token, command: { requestId: randomUUID(), kind: "reply", workerId: worker.id, expectedRevision: worker.revision, prompt: "Use A" } });
  await new Promise(r => setImmediate(r)); await f.service.list(f.scope);
  assert.equal(f.prompts.length, 2);
});
test("restart reconnects settled workers and observes external conversation interference", async t => {
  const f = await integration(t); await f.start(); await f.begin(); await f.finish();
  const [old] = await f.service.list(f.scope); assert.equal(old.status, "completed");
  await f.restart();
  await f.event("before_agent_start", { messageType: "user", prompt: "Unrelated new task" });
  const [now] = await f.service.list(f.scope); assert.equal(now.status, "unknown");
  const lease = f.service.arm(f.scope, 1);
  await assert.rejects(f.service.execute(f.scope, { token: lease.token, command: { requestId: randomUUID(), kind: "reply", workerId: old.id, expectedRevision: old.revision, prompt: "Stale reply" } }), /changed|unknown/);
  assert.equal(f.prompts.length, 1);
});
test("branch rollback publishes a newer invalidation and fences stale follow-up delivery", async t => {
  const f = await integration(t); const { lease } = await f.start(); await f.begin(); await f.finish();
  const earlier = structuredClone(f.entries);
  let [worker] = await f.service.list(f.scope);
  await f.service.execute(f.scope, { token: lease.token, command: { requestId: randomUUID(), kind: "reply", workerId: worker.id, expectedRevision: worker.revision, prompt: "Second turn" } });
  await new Promise(r => setImmediate(r)); await f.service.list(f.scope); await f.begin(); await f.finish();
  [worker] = await f.service.list(f.scope);
  await f.branchTo(earlier);
  const [now] = await f.service.list(f.scope);
  assert.equal(now.status, "unknown"); assert.ok(now.companionSequence! > worker.companionSequence!);
  await assert.rejects(f.service.execute(f.scope, { token: lease.token, command: { requestId: randomUUID(), kind: "reply", workerId: worker.id, expectedRevision: worker.revision, prompt: "Wrong branch" } }), /changed|unknown/);
  assert.equal(f.prompts.length, 2);
});

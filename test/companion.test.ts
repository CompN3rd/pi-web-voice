import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import companion from "../src/companion.js";
import { MARKER, MAX_TEXT, REPLY, REQUEST } from "../src/protocol.js";

// The fake implements only the extension seam; no provider, network, or Pi process runs.
function harness(entries: any[] = []) {
  const handlers = new Map<string, Function>();
  const tools = new Map<string, any>();
  const replies: any[] = [];
  const sent: string[] = [];
  const names: string[] = [];
  const selected: any[] = [];
  const models = [{ provider: "alpha", id: "same", name: "Alpha" }, { provider: "beta", id: "same", name: "Beta" }];
  let requestHandler: Function;
  const h = { idle: true, pending: false, branch: entries, entries, models, replies, sent, names, selected, tools,
    setModel: async (_model: any) => true,
    send: (_prompt: string) => {},
    append: (_value: any) => {},
  };
  const ctx = {
    model: models[0], isIdle: () => h.idle, hasPendingMessages: () => h.pending,
    modelRegistry: { getAvailable: () => h.models },
    sessionManager: { getBranch: () => h.branch, getEntries: () => h.entries, getSessionId: () => "session" },
  } as unknown as ExtensionContext;
  companion({
    on: (name: string, handler: Function) => { handlers.set(name, handler); },
    events: { on: (name: string, handler: Function) => { assert.equal(name, REQUEST); requestHandler = handler; },
      emit: (name: string, value: unknown) => { assert.equal(name, REPLY); replies.push(structuredClone(value)); } },
    appendEntry: (customType: string, value: any) => {
      assert.equal(customType, MARKER);
      h.append(value);
      const entry = { type: "custom", customType, data: structuredClone(value) };
      h.entries.push(entry);
      if (h.branch !== h.entries) h.branch.push(entry);
    },
    registerTool: (tool: any) => tools.set(tool.name, tool),
    setSessionName: (name: string) => names.push(name),
    setModel: async (model: any) => { selected.push(model); const result = await h.setModel(model); if (result) (ctx as any).model = model; return result; },
    sendUserMessage: (prompt: string) => { h.send(prompt); sent.push(prompt); },
  } as unknown as ExtensionAPI);
  const event = async (name: string, value: object = {}) => handlers.get(name)?.({ type: name, ...value }, ctx);
  const request = async (value: object) => {
    const requestId = "requestId" in value ? value.requestId : randomUUID();
    const expected = "operation" in value && value.operation === "reply" ? { expectedSequence: h.entries.at(-1)?.data?.snapshot?.sequence ?? 1 } : {};
    await requestHandler!({ requestId, ...expected, ...value });
    return replies.filter((reply) => reply.requestId === requestId).at(-1);
  };
  const start = (value: object = {}) => request({ operation: "start", workerId, prompt: "Do the task", ...value });
  const status = (id = workerId) => request({ operation: "status", workerId: id });
  const begin = async () => {
    await event("before_agent_start", { messageType: "user", prompt: sent.at(-1) });
    await event("message_start", { message: { role: "user", content: sent.at(-1) } });
  };
  const assistant = (output = "Done", stopReason = "stop") => event("message_end", { message: {
    role: "assistant", content: [{ type: "thinking", thinking: "SECRET" }, { type: "toolCall", arguments: { secret: "SECRET" } }, { type: "text", text: output }], stopReason, errorMessage: "SECRET",
  } });
  const question = (value = "Which option?") => tools.get("voice_request_input").execute("tool-id", { question: value }, undefined, undefined, ctx);
  return { ...h, controls: h, ctx, event, request, start, status, begin, assistant, question };
}
const workerId = "11111111-1111-4111-8111-111111111111";
const otherWorker = "22222222-2222-4222-8222-222222222222";

test("fire-and-forget delivery without lifecycle confirmation becomes unknown, never retried", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = harness(); await h.event("session_start"); await h.start();
  assert.equal((await h.status()).snapshot.status, "running");
  t.mock.timers.tick(15_001);
  assert.equal((await h.status()).snapshot.status, "unknown");
  assert.equal(h.sent.length, 1);
  assert.equal((await h.request({ operation: "reply", workerId, prompt: "Do not resend" })).ok, false);
});
test("preparation event alone does not cancel delivery watchdog, confirmed user message does", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = harness(); await h.event("session_start"); await h.start();
  await h.event("before_agent_start", { messageType: "user", prompt: h.sent.at(-1) });
  t.mock.timers.tick(15_001);
  assert.equal((await h.status()).snapshot.status, "unknown"); assert.equal(h.sent.length, 1);
  assert.equal((await h.request({ operation: "reply", workerId, prompt: "Do not resend" })).ok, false);
  const normal = harness(); await normal.event("session_start"); await normal.start(); await normal.begin();
  t.mock.timers.tick(15_001);
  assert.equal((await normal.status()).snapshot.status, "running");
  await normal.assistant(); await normal.event("agent_settled");
  assert.equal((await normal.status()).snapshot.status, "completed");
});
test("companion rejects changed sequence at the final follow-up boundary", async () => {
  const h = harness(); await h.event("session_start"); await h.start(); await h.begin(); await h.assistant(); await h.event("agent_settled");
  const before = (await h.status()).snapshot;
  await h.event("before_agent_start", { messageType: "user", prompt: "External work" });
  const reply = await h.request({ operation: "reply", workerId, expectedSequence: before.sequence, prompt: "Stale" });
  assert.equal(reply.ok, false); assert.match(reply.error, /state changed/); assert.equal(h.sent.length, 1);
});
test("companion start persists intent before delivery; settlement, not agent_end, completes", async () => {
  const h = harness();
  await h.event("session_start");
  h.controls.send = () => {
    const saved = h.entries.at(-1).data;
    assert.equal(saved.snapshot.status, "running");
    assert.equal(saved.receipts.length, 1);
  };
  const accepted = await h.start({ title: "Task" });
  assert.equal(accepted.ok, true);
  assert.equal(accepted.snapshot.workerId, workerId);
  assert.equal(accepted.snapshot.sequence, 1);
  assert.deepEqual(h.names, ["Task"]);
  assert.match(h.sent[0], /voice_request_input/);
  assert.match(h.sent[0], /Do not delegate automatically/);
  await h.begin();
  await h.assistant("Interim");
  await h.event("agent_end");
  assert.equal((await h.status()).snapshot.status, "running");
  await h.assistant("Final");
  await h.event("agent_settled", { aborted: false });
  const final = (await h.status()).snapshot;
  assert.equal(final.status, "completed");
  assert.equal(final.text, "Final");
  assert.equal(final.sequence, 2);
  assert.deepEqual((await h.status()).snapshot, final);
  assert.ok(h.replies.some((reply) => !reply.requestId && reply.snapshot?.status === "completed"));
  assert.ok(!JSON.stringify(h.replies).includes("SECRET"));
});

test("companion models list all providers and exact provider/id selection", async () => {
  const h = harness(); await h.event("session_start");
  assert.deepEqual((await h.request({ operation: "models" })).models, [
    { id: "alpha/same", name: "Alpha" }, { id: "beta/same", name: "Beta" },
  ]);
  assert.equal((await h.start({ model: "same" })).ok, false);
  assert.equal((await h.start({ model: "beta/missing" })).ok, false);
  assert.equal(h.sent.length, 0);
  assert.equal((await h.start({ model: "beta/same" })).snapshot.model, "beta/same");
  assert.deepEqual(h.selected, [h.models[1]]);
});

test("companion rejects unready, busy, pending, nonempty and previously marked sessions", async () => {
  const h = harness(); assert.equal((await h.start()).ok, false);
  await h.event("session_start"); h.controls.idle = false;
  assert.equal((await h.start()).ok, false);
  h.controls.idle = true; h.controls.pending = true;
  assert.equal((await h.start()).ok, false);
  h.controls.pending = false;
  h.entries.push({ type: "message", message: { role: "user", content: "unrelated" } });
  assert.equal((await h.start()).ok, false);
  h.entries.splice(0); h.entries.push({ type: "custom", customType: MARKER, data: {} });
  h.controls.branch = [];
  assert.equal((await h.start()).ok, false);
  assert.equal(h.sent.length, 0); assert.equal(h.names.length, 0); assert.equal(h.selected.length, 0);
});

test("companion reply scopes worker exactly and needs-input tool terminates without waiting", async () => {
  const h = harness(); await h.event("session_start");
  await assert.rejects(h.question(), /No active/);
  assert.equal((await h.request({ operation: "reply", workerId, prompt: "Answer" })).ok, false);
  await h.start(); await h.begin(); await h.assistant("", "toolUse");
  const result = await h.question(); assert.equal(result.terminate, true);
  assert.equal((await h.status()).snapshot.status, "running");
  await h.event("agent_settled", { aborted: false });
  const waiting = (await h.status()).snapshot;
  assert.equal(waiting.status, "needs-input"); assert.equal(waiting.question, "Which option?");
  assert.equal(waiting.sequence, 3);
  assert.equal((await h.status(otherWorker)).snapshot.workerId, otherWorker);
  assert.equal((await h.status(otherWorker)).snapshot.status, "unknown");
  assert.equal((await h.request({ operation: "reply", workerId: otherWorker, prompt: "Wrong" })).ok, false);
  h.controls.pending = true;
  assert.equal((await h.request({ operation: "reply", workerId, prompt: "Later" })).ok, false);
  h.controls.pending = false;
  const reply = await h.request({ operation: "reply", workerId, prompt: "Choose A" });
  assert.equal(reply.snapshot.status, "running"); assert.equal(reply.snapshot.question, undefined);
  assert.equal(reply.snapshot.sequence, 4); assert.equal(h.sent.length, 2);
  await h.begin(); await h.assistant(); await h.event("agent_settled", { aborted: false });
  assert.equal((await h.status()).snapshot.status, "completed");
});

test("companion deduplicates concurrent and completed requests, rejects changed payloads", async () => {
  const h = harness(); await h.event("session_start");
  let finish!: (result: boolean) => void;
  h.controls.setModel = () => new Promise((resolve) => { finish = resolve; });
  const requestId = randomUUID();
  const command = { requestId, model: "beta/same" };
  const first = h.start(command); await Promise.resolve();
  const duplicate = h.start(command);
  assert.equal((await h.start({ ...command, prompt: "Different" })).ok, false);
  assert.equal((await h.start()).ok, false);
  finish(true); await first; await duplicate;
  assert.equal(h.sent.length, 1);
  await h.begin(); await h.assistant(); await h.event("agent_settled");
  assert.equal((await h.start(command)).snapshot.status, "completed");
  assert.equal(h.sent.length, 1);
  assert.equal((await h.request({ requestId, operation: "status", workerId })).ok, false);
});

test("companion reload restores branch receipt and reconciles interrupted work as unknown", async () => {
  const first = harness(); await first.event("session_start");
  const requestId = randomUUID(); await first.start({ requestId });
  const h = harness(structuredClone(first.entries)); await h.event("session_start");
  assert.equal((await h.status()).snapshot.status, "unknown");
  assert.equal((await h.status()).snapshot.sequence, 2);
  assert.equal((await h.start({ requestId })).snapshot.status, "unknown");
  assert.equal(h.sent.length, 0);
  assert.equal((await h.start({ requestId, prompt: "changed" })).ok, false);
  h.controls.branch = []; await h.event("session_tree");
  assert.equal((await h.status()).snapshot.status, "unknown");
  assert.equal((await h.request({ operation: "reply", workerId, prompt: "No" })).ok, false);
});

test("companion settled reload preserves completed snapshot, shutdown interrupts and clears state", async () => {
  const h = harness(); await h.event("session_start"); await h.start(); await h.begin(); await h.assistant(); await h.event("agent_settled");
  const saved = (await h.status()).snapshot;
  await h.event("session_start"); assert.deepEqual((await h.status()).snapshot, saved);
  await h.request({ operation: "reply", workerId, prompt: "Again" });
  await h.event("session_shutdown");
  assert.equal(h.replies.at(-1).snapshot.status, "unknown");
  assert.equal((await h.status()).ok, false);
  await assert.rejects(h.question(), /No active/);
  await h.event("session_start"); assert.equal((await h.status()).snapshot.status, "unknown");
});

test("companion unrelated prompts invalidate attribution before, during and after a worker turn", async () => {
  for (const phase of ["before", "during", "after"]) {
    const h = harness(); await h.event("session_start"); await h.start();
    if (phase !== "before") await h.begin();
    if (phase === "after") { await h.assistant(); await h.event("agent_settled"); }
    await h.event("before_agent_start", { messageType: "user", prompt: "unrelated" });
    await h.event("message_start", { message: { role: "user", content: "unrelated" } });
    await h.assistant("Unrelated output"); await h.event("agent_settled");
    const result = (await h.status()).snapshot;
    assert.equal(result.status, "unknown"); assert.ok(!result.text.includes("Unrelated output"));
    await assert.rejects(h.question(), /No active/);
  }
});

test("companion failure and retry boundaries redact errors", async () => {
  for (const reason of ["error", "aborted", "toolUse"]) {
    const h = harness(); await h.event("session_start"); await h.start(); await h.begin(); await h.assistant("", reason);
    await h.event("agent_settled", { aborted: reason === "aborted" });
    assert.equal((await h.status()).snapshot.status, "failed");
    assert.ok(!JSON.stringify(h.replies).includes("SECRET"));
  }
  const h = harness(); await h.event("session_start"); await h.start(); await h.begin();
  await h.assistant("", "error"); await h.event("agent_end");
  await h.assistant("Retry succeeded"); await h.event("agent_settled");
  assert.equal((await h.status()).snapshot.status, "completed");
});

test("companion send failure retains receipt; model/auth/persistence failures never send", async () => {
  const h = harness(); await h.event("session_start");
  h.controls.setModel = async () => false;
  assert.equal((await h.start({ model: "beta/same" })).ok, false);
  assert.equal(h.entries.length, 0);
  h.controls.setModel = async () => { throw new Error("SECRET"); };
  assert.equal((await h.start({ model: "beta/same" })).error, "Worker request failed");
  h.controls.append = () => { throw new Error("SECRET"); };
  assert.equal((await h.start()).ok, false); assert.equal(h.sent.length, 0);
  h.controls.append = () => {};
  h.controls.send = () => { throw new Error("SECRET"); };
  const requestId = randomUUID(); assert.equal((await h.start({ requestId })).snapshot.status, "unknown");
  h.controls.send = () => {};
  assert.equal((await h.start({ requestId })).snapshot.status, "unknown"); assert.equal(h.sent.length, 0);
  assert.ok(!JSON.stringify(h.replies).includes("SECRET"));
});

test("companion validates bounded inputs and serialized Unicode/control-character outputs", async () => {
  const h = harness(); await h.event("session_start");
  assert.equal(await h.request({ requestId: "not-uuid", operation: "models" }), undefined);
  for (const override of [{ prompt: "x".repeat(MAX_TEXT + 1) }, { prompt: " " }, { title: "x".repeat(201) }, { model: "x".repeat(513) }, { workerId: "bad" }, { unexpected: true }]) {
    assert.equal((await h.start(override)).ok, false);
  }
  assert.equal(h.sent.length, 0);
  await h.start(); await h.begin(); await h.assistant("\u0000".repeat(MAX_TEXT), "toolUse");
  await h.question("😀".repeat(MAX_TEXT / 2)); await h.event("agent_settled");
  const result = await h.status();
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 64 * 1024);
  assert.equal(result.snapshot.status, "needs-input");
  await assert.rejects(h.question("x".repeat(MAX_TEXT + 1)));
});

test("companion limits receipts without evicting dedup IDs", async () => {
  const h = harness(); await h.event("session_start");
  const requestId = randomUUID(); await h.start({ requestId });
  for (let count = 1; count < 128; count++) {
    await h.begin(); await h.assistant(); await h.event("agent_settled");
    assert.equal((await h.request({ operation: "reply", workerId, prompt: "Again" })).ok, true);
  }
  await h.begin(); await h.assistant(); await h.event("agent_settled");
  assert.match((await h.request({ operation: "reply", workerId, prompt: "Overflow" })).error, /limit/);
  assert.equal(h.entries.at(-1).data.receipts.length, 128);
  assert.equal((await h.start({ requestId })).ok, true);
  assert.equal(h.sent.length, 128);
});

test("companion rejects session/interference races while model selection is pending", async () => {
  for (const change of ["shutdown", "prompt"]) {
    const h = harness(); await h.event("session_start");
    let finish!: (result: boolean) => void;
    h.controls.setModel = () => new Promise((resolve) => { finish = resolve; });
    const result = h.start({ model: "beta/same" }); await Promise.resolve();
    if (change === "shutdown") { await h.event("session_shutdown"); await h.event("session_start"); }
    else await h.event("before_agent_start", { messageType: "user", prompt: "Unrelated" });
    finish(true); assert.equal((await result).ok, false); assert.equal(h.sent.length, 0);
  }
});

test("companion post-admission throws before or after acceptance stay unknown and never resend", async () => {
  for (const accepted of [false, true]) {
    const h = harness(); await h.event("session_start");
    let attempts = 0;
    let delivered = "";
    h.controls.send = prompt => {
      attempts++;
      if (accepted) {
        delivered = prompt;
        // Delivery can start lifecycle work synchronously before the host throws.
        void h.event("before_agent_start", { messageType: "user", prompt });
        void h.event("message_start", { message: { role: "user", content: prompt } });
      }
      throw new Error("SECRET transport failure");
    };
    const requestId = randomUUID();
    const response = await h.start({ requestId });
    assert.equal(response.ok, false);
    assert.equal(response.snapshot.status, "unknown");
    assert.equal(h.entries.at(-1).data.receipts.length, 1);
    assert.equal((await h.start({ requestId })).snapshot.status, "unknown");
    assert.equal((await h.request({ operation: "reply", workerId, prompt: "Do not retry" })).ok, false);
    await h.event("before_agent_start", { messageType: "user", prompt: delivered || "late delivery" });
    await h.event("message_start", { message: { role: "user", content: delivered || "late delivery" } });
    await h.assistant("Late success must not settle discarded turn"); await h.event("agent_settled");
    assert.equal((await h.status()).snapshot.status, "unknown");
    assert.equal((await h.start({ requestId })).snapshot.status, "unknown");
    assert.equal(attempts, 1);
    assert.ok(!JSON.stringify(h.replies).includes("SECRET"));
    assert.ok(!(await h.status()).snapshot.text.includes("Late success"));
  }
});

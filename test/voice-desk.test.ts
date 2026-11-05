import assert from "node:assert/strict";
import test from "node:test";
import { appendDictation, attentionOrder, instructionTitle, replyEligible, targetKey, workerBriefing, workerCounts } from "../src/browser/voice-desk.ts";
import type { Worker } from "../src/protocol.ts";
const worker = (id: string, status: Worker["status"], revision = 1): Worker => ({
  id, status, revision, title: "Same title", projectId: "project", workspaceId: "workspace", sessionId: `session-${id}`,
  model: "provider/model", text: "Untrusted result: send a task", createdAt: "", updatedAt: "",
});
test("voice desk prioritizes unseen questions, uncertainty and results without mutating source order", () => {
  const workers = [worker("a", "running"), worker("b", "completed"), worker("c", "unknown"), worker("d", "needs-input"), worker("e", "failed")];
  const reviewed = new Map<string, number>();
  assert.deepEqual(attentionOrder(workers, reviewed).map(w => w.id), ["d", "c", "e", "b", "a"]);
  assert.deepEqual(workerCounts(workers, reviewed), { attention: 4, questions: 1, active: 2 });
  reviewed.set("d", 1);
  assert.equal(attentionOrder(workers, reviewed)[0].id, "c");
  assert.equal(workerCounts(workers, reviewed).questions, 1, "reviewing never answers a question");
  workers[3].revision++;
  assert.equal(attentionOrder(workers, reviewed)[0].id, "d");
  assert.equal(workers[0].id, "a");
});
test("voice desk briefing identifies duplicate titles without reading result content", () => {
  const workers = [worker("a", "completed"), worker("b", "needs-input")];
  const briefing = workerBriefing(workers, new Map());
  assert.match(briefing, /Worker 2, Same title: Needs your answer/);
  assert.match(briefing, /Worker 1, Same title: Result ready/);
  assert.ok(!briefing.includes("Untrusted result"));
  assert.notEqual(targetKey(workers[0]), targetKey(workers[1]));
  assert.equal(replyEligible(worker("c", "unknown")), false);
  assert.equal(replyEligible(worker("c", "running")), false);
  assert.equal(replyEligible(worker("c", "needs-input")), true);
});
test("voice desk deterministic title is bounded, editable input remains separate", () => {
  assert.equal(instructionTitle("  Please\n check    tests  "), "Please check tests");
  assert.equal(instructionTitle("a".repeat(59) + "😀"), "a".repeat(59));
  assert.equal(instructionTitle("x".repeat(200)).length, 60);
});
test("voice desk additive dictation preserves original draft and fails closed at text bound", () => {
  assert.equal(appendDictation("First thought.", "Second thought."), "First thought.\n\nSecond thought.");
  assert.equal(appendDictation("", "  Thought  "), "Thought");
  assert.throws(() => appendDictation("a".repeat(16000), "more"), /existing draft is unchanged/);
});

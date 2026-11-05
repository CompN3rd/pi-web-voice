import type { Worker, WorkerStatus } from "../protocol.ts";

export const replyEligible = (worker: Worker) => ["needs-input", "completed", "failed"].includes(worker.status);
export const targetKey = (worker: Worker) => `${worker.id}:${worker.revision}`;
export const needsAttention = (worker: Worker) => ["needs-input", "unknown", "failed", "completed"].includes(worker.status);
export const statusLabel: Record<WorkerStatus, string> = {
  starting: "Starting", running: "Working", "needs-input": "Needs your answer",
  completed: "Result ready", failed: "Turn failed", unknown: "Check conversation",
};
export const statusGuidance: Record<WorkerStatus, string> = {
  starting: "Admitted; delivery may still be pending. Do not resubmit.",
  running: "Working independently. Voice off will not stop this worker.",
  "needs-input": "Read the saved question, then approve an exact reply.",
  completed: "Turn settled, not verified success. Read the result before continuing.",
  failed: "Inspect the failure before deciding on a follow-up.",
  unknown: "Delivery or tracking is uncertain. Inspect the conversation; never blindly retry.",
};
const priority: Record<WorkerStatus, number> = { "needs-input": 0, unknown: 1, failed: 2, completed: 3, starting: 4, running: 5 };
/** Unreviewed revisions first. Reviewing is local UI state, never worker acknowledgement or authority. */
export function attentionOrder(workers: readonly Worker[], reviewed: ReadonlyMap<string, number>): Worker[] {
  return [...workers].sort((a, b) => {
    const unseen = (w: Worker) => needsAttention(w) && reviewed.get(w.id) !== w.revision;
    return Number(unseen(b)) - Number(unseen(a)) || priority[a.status] - priority[b.status] || a.id.localeCompare(b.id);
  });
}
export function workerCounts(workers: readonly Worker[], reviewed: ReadonlyMap<string, number>) {
  return {
    attention: workers.filter(w => needsAttention(w) && reviewed.get(w.id) !== w.revision).length,
    questions: workers.filter(w => w.status === "needs-input").length,
    active: workers.filter(w => ["starting", "running", "unknown"].includes(w.status)).length,
  };
}
/** Deterministic metadata briefing, not model-generated claims or an automatic read of worker content. */
export function workerBriefing(workers: readonly Worker[], reviewed: ReadonlyMap<string, number>): string {
  if (!workers.length) return "No tracked workers in this workspace.";
  const counts = workerCounts(workers, reviewed);
  return `${counts.attention} updates to review. ${counts.questions} workers need an answer. ${counts.active} of 3 active or uncertain slots occupied. `
    + attentionOrder(workers, reviewed).map(w => `Worker ${workers.findIndex(item => item.id === w.id) + 1}, ${w.title}: ${statusLabel[w.status]}.`).join(" ");
}
export function instructionTitle(prompt: string): string {
  return prompt.trim().replace(/\s+/g, " ").slice(0, 60).replace(/[\uD800-\uDBFF]$/, "");
}
export function appendDictation(draft: string, utterance: string): string {
  const result = [draft.trim(), utterance.trim()].filter(Boolean).join("\n\n");
  if (result.length > 16_000) throw new Error("This thought would exceed 16,000 characters. Shorten the draft and record again; the existing draft is unchanged.");
  return result;
}

import { createHash } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { MARKER, MAX_TEXT, REPLY, REQUEST, record, text, uuid } from "./protocol.js";

type Status = "running" | "needs-input" | "completed" | "failed" | "unknown";
interface Snapshot { sequence: number; workerId: string; status: Status; text: string; question?: string; model: string }
interface Request { requestId: string; operation: "status" | "models" | "start" | "reply"; workerId?: string; prompt?: string; title?: string; model?: string }
interface Receipt { requestId: string; digest: string }
interface State { snapshot: Snapshot; receipts: Receipt[] }
interface Turn { prompt: string; started: boolean; userSeen: boolean; text: string; stopReason: string; question?: string }
interface Response { ok: boolean; snapshot?: Snapshot; models?: { id: string; name: string }[]; error?: string }
const MAX_RECEIPTS = 128;
const MAX_MODEL = 512;
class RequestError extends Error {}
// Budget serialized text, including JSON escaping, below the peer's 64 KiB envelope.
function outputText(value: string): string {
  let end = Math.min(value.length, MAX_TEXT);
  if (Buffer.byteLength(JSON.stringify(value.slice(0, end)), "utf8") <= 20_000) return value.slice(0, end);
  let low = 0;
  while (low < end) {
    const middle = Math.ceil((low + end) / 2);
    if (Buffer.byteLength(JSON.stringify(value.slice(0, middle)), "utf8") <= 19_950) low = middle;
    else end = middle - 1;
  }
  return value.slice(0, low) + "\n[truncated]";
}
const INSTRUCTION = "You are a text-only worker for Pi Web voice. Use voice_request_input for decisions or clarification; call it alone and wait for a normal text reply. Give a concise final summary. Do not delegate automatically unless the task explicitly authorizes delegation. Respect the existing tools and permissions.\n\n";

function bounded(value: unknown, name: string, max: number): string {
  // Preserve exact prompt/model bytes: whitespace changes must not bypass request deduplication.
  text(value, name, max);
  return value as string;
}
function parseRequest(value: unknown): Request {
  const data = record(value);
  const requestId = uuid(data.requestId);
  const operation = data.operation;
  if (operation !== "status" && operation !== "models" && operation !== "start" && operation !== "reply") throw new RequestError("Invalid operation");
  const allowed = operation === "models" ? ["requestId", "operation"] : operation === "status"
    ? ["requestId", "operation", "workerId"] : ["requestId", "operation", "workerId", "prompt", "title", "model"];
  if (Object.keys(data).some((key) => !allowed.includes(key))) throw new RequestError("Unexpected request field");
  return { requestId, operation,
    ...(operation === "models" ? {} : { workerId: uuid(data.workerId) }),
    ...(operation === "start" || operation === "reply" ? {
      prompt: bounded(data.prompt, "prompt", MAX_TEXT),
      ...(data.title === undefined ? {} : { title: bounded(data.title, "title", 200) }),
      ...(data.model === undefined ? {} : { model: bounded(data.model, "model", MAX_MODEL) }),
    } : {}),
  };
}
function digest(request: Request): string { return createHash("sha256").update(JSON.stringify(request)).digest("hex"); }
function restore(value: unknown): State {
  const data = record(value);
  const raw = record(data.snapshot);
  const statuses: Status[] = ["running", "needs-input", "completed", "failed", "unknown"];
  if (!statuses.includes(raw.status as Status) || typeof raw.text !== "string" || raw.text.length > MAX_TEXT
    || typeof raw.model !== "string" || raw.model.length > MAX_MODEL) throw new RequestError("Invalid saved snapshot");
  if (!Number.isSafeInteger(raw.sequence) || (raw.sequence as number) < 1) throw new RequestError("Invalid saved sequence");
  const snapshot: Snapshot = { sequence: raw.sequence as number, workerId: uuid(raw.workerId), status: raw.status as Status, text: outputText(raw.text), model: raw.model };
  if (raw.question !== undefined) snapshot.question = outputText(bounded(raw.question, "question", MAX_TEXT));
  if (!Array.isArray(data.receipts) || data.receipts.length > MAX_RECEIPTS) throw new RequestError("Invalid saved receipts");
  const receipts = data.receipts.map((value): Receipt => {
    const receipt = record(value);
    if (typeof receipt.digest !== "string" || !/^[a-f0-9]{64}$/.test(receipt.digest)) throw new RequestError("Invalid saved receipt");
    return { requestId: uuid(receipt.requestId), digest: receipt.digest };
  });
  return { snapshot, receipts };
}

export default function companion(pi: ExtensionAPI): void {
  let context: ExtensionContext | undefined;
  let state: State | undefined;
  let turn: Turn | undefined;
  let epoch = 0;
  let promptVersion = 0;
  let pending: { requestId: string; digest: string; result: Promise<Response> } | undefined;
  const snapshot = () => state ? { ...state.snapshot } : undefined;
  const persist = () => { if (state) pi.appendEntry(MARKER, structuredClone(state)); };
  const publish = () => { if (state) pi.events.emit(REPLY, { snapshot: snapshot() }); };
  const transition = (status: Status, output: string, question?: string) => {
    if (!state) return;
    const next = { ...state.snapshot, status, text: outputText(output), question };
    if (state.snapshot.status === next.status && state.snapshot.text === next.text && state.snapshot.question === next.question) return;
    state.snapshot = { sequence: state.snapshot.sequence + 1, workerId: state.snapshot.workerId, model: state.snapshot.model, status, text: next.text, ...(question ? { question } : {}) };
    persist();
    publish();
  };
  const interfere = () => {
    promptVersion++;
    if (!state) return;
    turn = undefined;
    transition("unknown", "An unrelated prompt changed this worker conversation.");
  };
  const load = (ctx: ExtensionContext) => {
    epoch++;
    context = ctx;
    state = undefined;
    turn = undefined;
    pending = undefined;
    const marker = [...ctx.sessionManager.getBranch()].reverse().find((entry) => entry.type === "custom" && entry.customType === MARKER);
    if (marker?.type !== "custom") return;
    try { state = restore(marker.data); } catch { return; }
    if (state.snapshot.status === "running") transition("unknown", "Worker execution was interrupted; inspect the conversation before replying.");
    else publish();
  };
  pi.on("session_start", (_event, ctx) => { load(ctx); });
  pi.on("session_tree", (_event, ctx) => { load(ctx); });
  pi.on("session_shutdown", () => {
    try { if (state?.snapshot.status === "running") transition("unknown", "Worker execution was interrupted by session shutdown."); }
    finally { epoch++; context = undefined; state = undefined; turn = undefined; pending = undefined; }
  });
  pi.on("before_agent_start", (event) => {
    if (turn && !turn.started && event.messageType === "user" && event.prompt === turn.prompt && !event.images?.length) turn.started = true;
    else interfere();
  });
  pi.on("message_start", (event) => {
    if (event.message.role !== "user") return;
    const content = event.message.content;
    const plain = typeof content === "string" ? content : content.every((part) => part.type === "text")
      ? content.map((part) => part.type === "text" ? part.text : "").join("") : undefined;
    if (turn && !turn.userSeen && plain === turn.prompt) turn.userSeen = true;
    else interfere();
  });
  pi.on("message_end", (event) => {
    if (!turn?.started || event.message.role !== "assistant") return;
    // Never publish thinking, tool arguments/results, or provider error payloads.
    let output = "";
    for (const part of event.message.content) {
      if (part.type !== "text") continue;
      output += (output ? "\n" : "") + part.text.slice(0, MAX_TEXT - output.length);
      if (output.length >= MAX_TEXT) break;
    }
    turn.text = output.slice(0, MAX_TEXT);
    turn.stopReason = event.message.stopReason;
  });
  // agent_end is not final: Pi may retry or compact before settlement.
  pi.on("agent_settled", (event) => {
    if (!turn) return;
    const result = turn;
    turn = undefined;
    if (!result.started) transition("unknown", "Worker settled without its expected prompt.");
    else if (event.aborted || result.stopReason === "error" || result.stopReason === "aborted") transition("failed", "Worker execution failed or was aborted. Inspect the conversation.");
    else if (result.question) transition("needs-input", result.text, result.question);
    else if (result.stopReason === "stop" && result.text.trim()) transition("completed", result.text);
    else transition("failed", "Worker ended without a successful final text response.");
  });
  pi.registerTool({
    name: "voice_request_input", label: "Request voice worker input", exposure: "model-only",
    description: "Ask a concise question and end this worker turn awaiting a normal text reply. Call this tool alone. Only available for an active marked Pi Web voice worker.",
    parameters: Type.Object({ question: Type.String({ minLength: 1, maxLength: MAX_TEXT }) }, { additionalProperties: false }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (!state || !turn?.started || !context || ctx.sessionManager.getSessionId() !== context.sessionManager.getSessionId()) throw new RequestError("No active voice worker turn");
      const question = outputText(bounded(params.question, "question", MAX_TEXT));
      turn.question = question;
      if (state.snapshot.question !== question) {
        state.snapshot = { ...state.snapshot, question, sequence: state.snapshot.sequence + 1 };
        persist();
        publish();
      }
      return { content: [{ type: "text", text: "Question saved. Wait for the user's next text reply." }], details: undefined, terminate: true };
    },
  });

  function checkScope(request: Request, ctx: ExtensionContext): void {
    if (!ctx.isIdle() || ctx.hasPendingMessages() || turn) throw new RequestError("Session must be idle with no pending messages");
    if (request.operation === "start") {
      if (state || ctx.sessionManager.getEntries().some((entry) => entry.type === "message" || entry.type === "custom" && entry.customType === MARKER)
        || ctx.sessionManager.getBranch().some((entry) => entry.type === "compaction" || entry.type === "branch_summary")) throw new RequestError("Start requires a fresh empty conversation with no worker marker");
    } else if (!state || state.snapshot.workerId !== request.workerId) throw new RequestError("Worker does not match this conversation");
  }
  async function execute(request: Request, hash: string): Promise<Response> {
    const ctx = context;
    if (!ctx) return { ok: false, error: "Companion session is not ready" };
    let accepted = false;
    const generation = epoch;
    const version = promptVersion;
    try {
      checkScope(request, ctx);
      if ((state?.receipts.length ?? 0) >= MAX_RECEIPTS) throw new RequestError("Worker receipt limit (128) reached; create a new worker");
      let model = ctx.model;
      if (request.model !== undefined) {
        model = ctx.modelRegistry.getAvailable().find((candidate) => `${candidate.provider}/${candidate.id}` === request.model);
        if (!model) throw new RequestError("Requested model is not available");
        if (!await pi.setModel(model)) throw new RequestError("Requested model authentication is unavailable");
      }
      if (generation !== epoch || version !== promptVersion || context !== ctx) throw new RequestError("Session changed while selecting the model");
      checkScope(request, ctx);
      const modelId = model ? `${model.provider}/${model.id}` : "";
      if (!modelId || modelId.length > MAX_MODEL) throw new RequestError("No usable session model selected");
      const next: State = { snapshot: { sequence: (state?.snapshot.sequence ?? 0) + 1, workerId: request.workerId!, status: "running", text: "", model: modelId },
        receipts: [...(state?.receipts ?? []), { requestId: request.requestId, digest: hash }] };
      // Intent and receipt must be durable before a prompt can be delivered.
      pi.appendEntry(MARKER, structuredClone(next));
      state = next;
      accepted = true;
      if (request.operation === "start") pi.setSessionName(request.title ?? "Voice worker");
      turn = { prompt: INSTRUCTION + request.prompt!, started: false, userSeen: false, text: "", stopReason: "" };
      publish();
      pi.sendUserMessage(turn.prompt);
      return { ok: true, snapshot: snapshot() };
    } catch (error) {
      if (accepted && generation === epoch) {
        turn = undefined;
        transition("failed", "Worker prompt delivery failed. Inspect the conversation before continuing.");
        return { ok: false, snapshot: snapshot(), error: "Worker prompt delivery failed" };
      }
      // Errors from provider/model APIs can contain secrets. Only expose our fixed validation errors.
      const safe = error instanceof Error && ["Session must be idle with no pending messages", "Start requires a fresh empty conversation with no worker marker", "Worker does not match this conversation", "Worker receipt limit (128) reached; create a new worker", "Requested model is not available", "Requested model authentication is unavailable", "Session changed while selecting the model", "No usable session model selected"].includes(error.message);
      return { ok: false, error: safe ? (error as Error).message : "Worker request failed" };
    }
  }
  pi.events.on(REQUEST, async (data) => {
    let requestId: string;
    try { requestId = uuid(record(data).requestId); } catch { return; }
    const respond = (result: Response) => pi.events.emit(REPLY, { requestId, ...result });
    try {
      const request = parseRequest(data);
      const hash = digest(request);
      if (pending?.requestId === requestId) {
        if (pending.digest !== hash) throw new RequestError("Request ID was reused with a different payload");
        respond(await pending.result);
        return;
      }
      const receipt = state?.receipts.find((item) => item.requestId === requestId);
      if (receipt) {
        if (receipt.digest !== hash) throw new RequestError("Request ID was reused with a different payload");
        respond({ ok: true, snapshot: snapshot() });
        return;
      }
      if (!context) throw new RequestError("Companion session is not ready");
      if (request.operation === "models") {
        const models = context.modelRegistry.getAvailable().map((model) => ({ id: `${model.provider}/${model.id}`, name: model.name }));
        if (Buffer.byteLength(JSON.stringify(models), "utf8") > 48_000 || models.length > 4096 || models.some((model) => model.id.length > MAX_MODEL || model.name.length > MAX_MODEL)) throw new RequestError("Available model catalogue exceeds response limits");
        respond({ ok: true, models });
      } else if (request.operation === "status") {
        respond({ ok: true, snapshot: state?.snapshot.workerId === request.workerId ? snapshot()
          : { sequence: 0, workerId: request.workerId!, status: "unknown", text: "Worker is not marked in this conversation.", model: "" } });
      } else {
        if (pending) throw new RequestError("Another worker request is being accepted");
        // Reserve synchronously, including when setModel yields to another event.
        const generation = epoch;
        const reservation = { requestId, digest: hash, result: Promise.resolve().then(() => generation === epoch
          ? execute(request, hash) : { ok: false, error: "Session changed before request acceptance" }) };
        pending = reservation;
        try { respond(await reservation.result); }
        finally { if (pending === reservation) pending = undefined; }
      }
    } catch (error) {
      respond({ ok: false, error: error instanceof RequestError ? error.message.slice(0, 300) : "Invalid worker request" });
    }
  });
}

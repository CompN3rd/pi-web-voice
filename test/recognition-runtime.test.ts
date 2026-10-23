import assert from "node:assert/strict";
import test from "node:test";
import { WorkerRecognitionRuntime } from "../src/browser/recognition-runtime.ts";
import { MAX_TRANSCRIPT_CHARACTERS } from "../src/browser/recognition-pcm.ts";

class FakeWorker {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: { preventDefault(): void }) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  messages: { message: { id: number; type: string; pcm?: Float32Array; options?: unknown }; transfer: Transferable[] }[] = [];
  terminations = 0;
  postMessage(message: FakeWorker["messages"][number]["message"], transfer: Transferable[]) { this.messages.push({ message, transfer }); }
  terminate() { this.terminations++; }
  reply(data: unknown) { this.onmessage?.({ data }); }
}

async function fixture(run: (runtime: WorkerRecognitionRuntime, worker: FakeWorker) => Promise<void>) {
  const original = Object.getOwnPropertyDescriptor(globalThis, "Worker");
  const worker = new FakeWorker();
  Object.defineProperty(globalThis, "Worker", { configurable: true, value: class {
    constructor(url: URL, options: WorkerOptions) {
      assert.ok(url.href.endsWith("/recognition-worker.js"));
      assert.equal(options.type, "module");
      return worker;
    }
  } });
  let runtime: WorkerRecognitionRuntime | undefined;
  try {
    runtime = new WorkerRecognitionRuntime();
    await run(runtime, worker);
  } finally {
    runtime?.terminate();
    if (original) Object.defineProperty(globalThis, "Worker", original); else Reflect.deleteProperty(globalThis, "Worker");
  }
}

async function prepare(runtime: WorkerRecognitionRuntime, worker: FakeWorker) {
  const preparing = runtime.prepare(() => {});
  worker.reply({ id: worker.messages.at(-1)!.message.id, type: "ready" });
  await preparing;
}

test("WorkerRecognitionRuntime transfers PCM, ignores stale IDs and terminates pending inference", async () => fixture(async (runtime, worker) => {
  const statuses: string[] = [];
  const preparing = runtime.prepare(message => statuses.push(message));
  const id = worker.messages[0].message.id;
  worker.reply({ id: id + 1, type: "status", message: "stale" });
  worker.reply({ id, type: "status", message: "checked" });
  worker.reply({ id, type: "ready" });
  await preparing;
  assert.deepEqual(statuses, ["checked"]);
  const pcm = new Float32Array(8000).fill(0.1);
  const inference = runtime.transcribe(pcm);
  assert.deepEqual(worker.messages[1].transfer, [pcm.buffer]);
  runtime.terminate();
  await assert.rejects(inference, /stopped or timed out/);
  worker.reply({ id: worker.messages[1].message.id, type: "transcript", text: "late result" });
  await assert.rejects(runtime.prepare(() => {}), /unavailable/);
  assert.equal(worker.terminations, 1);
}));

test("WorkerRecognitionRuntime forwards cache/download/import preparation and fences all canceled callbacks", async () => {
  const options = [undefined, { source: "cache" } as const, { source: "download" } as const, { source: "import", file: new Blob(["PIVOICE1"]) } as const];
  for (const option of options) await fixture(async (runtime, worker) => {
    const statuses: string[] = [];
    const preparing = runtime.prepare(message => statuses.push(message), option);
    const { message, transfer } = worker.messages[0];
    assert.deepEqual(message.options, option ?? { source: "cache" });
    assert.deepEqual(transfer, []);
    const late = worker.onmessage!;
    const lateError = worker.onerror!;
    runtime.terminate();
    await assert.rejects(preparing, /stopped/);
    assert.equal(worker.onmessage, null);
    assert.equal(worker.onerror, null);
    assert.equal(worker.onmessageerror, null);
    late({ data: { id: message.id, type: "status", message: "late" } });
    late({ data: { id: message.id, type: "ready" } });
    assert.deepEqual(statuses, []);
    assert.equal(worker.terminations, 1);
    lateError({ preventDefault() {} });
    await assert.rejects(runtime.prepare(() => {}), /unavailable/);
  });
});

test("WorkerRecognitionRuntime rejects mismatched or malformed matching-ID responses and closes the worker", async () => {
  const scenarios = [
    { operation: "prepare", response: { type: "transcript", text: "not readiness" } },
    { operation: "prepare", response: { type: "status", message: 42 } },
    { operation: "transcribe", response: { type: "ready" } },
    { operation: "transcribe", response: { type: "transcript", text: 42 } },
    { operation: "transcribe", response: { type: "transcript", text: "x".repeat(MAX_TRANSCRIPT_CHARACTERS + 1) } },
    { operation: "transcribe", response: { type: "unknown" } },
  ];
  for (const { operation, response } of scenarios) await fixture(async (runtime, worker) => {
    if (operation === "transcribe") await prepare(runtime, worker);
    const request = operation === "prepare" ? runtime.prepare(() => {}) : runtime.transcribe(new Float32Array(8000));
    worker.reply({ id: worker.messages.at(-1)!.message.id, ...response });
    await assert.rejects(request, /Invalid local speech worker response/);
    assert.equal(worker.terminations, 1);
    await assert.rejects(runtime.prepare(() => {}), /unavailable/);
  });
});

test("WorkerRecognitionRuntime accepts empty and maximum-length transcripts only for transcription", async () => fixture(async (runtime, worker) => {
  await prepare(runtime, worker);
  for (const text of ["", "x".repeat(MAX_TRANSCRIPT_CHARACTERS)]) {
    const request = runtime.transcribe(new Float32Array(8000));
    worker.reply({ id: worker.messages.at(-1)!.message.id, type: "transcript", text });
    assert.equal(await request, text);
  }
}));

test("WorkerRecognitionRuntime settles preparation when a status callback throws or cancels", async () => {
  for (const outcome of ["throw", "cancel"]) await fixture(async (runtime, worker) => {
    const request = runtime.prepare(() => {
      if (outcome === "throw") throw new Error("UI callback failed");
      runtime.terminate();
    });
    const late = worker.onmessage!;
    const id = worker.messages[0].message.id;
    worker.reply({ id, type: "status", message: "Progress" });
    await assert.rejects(request, outcome === "throw" ? /status callback failed/ : /stopped/);
    late({ data: { id, type: "ready" } });
    assert.equal(worker.terminations, 1);
    await assert.rejects(runtime.prepare(() => {}), /unavailable/);
  });
});

test("WorkerRecognitionRuntime rejects worker errors without leaving a reusable failed runtime", async () => fixture(async (runtime, worker) => {
  const request = runtime.prepare(() => {});
  worker.reply({ id: worker.messages[0].message.id, type: "error", message: "Pack missing" });
  await assert.rejects(request, /Pack missing/);
  assert.equal(worker.terminations, 1);
  await assert.rejects(runtime.prepare(() => {}), /unavailable/);
}));

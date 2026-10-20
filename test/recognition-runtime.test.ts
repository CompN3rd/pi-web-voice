import assert from "node:assert/strict";
import test from "node:test";
import { WorkerRecognitionRuntime } from "../src/browser/recognition-runtime.ts";

test("WorkerRecognitionRuntime transfers bounded PCM, ignores stale IDs and terminates pending inference", async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "Worker");
  let instance!: FakeWorker;
  class FakeWorker {
    onmessage?: (event: { data: unknown }) => void;
    onerror?: (event: { preventDefault(): void }) => void;
    onmessageerror?: () => void;
    messages: { message: { id: number; type: string; pcm?: Float32Array }; transfer: Transferable[] }[] = [];
    terminations = 0;
    constructor(url: URL, options: WorkerOptions) {
      instance = this;
      assert.ok(url.href.endsWith("/recognition-worker.js"));
      assert.equal(options.type, "module");
    }
    postMessage(message: { id: number; type: string; pcm?: Float32Array }, transfer: Transferable[]) { this.messages.push({ message, transfer }); }
    terminate() { this.terminations++; }
    reply(data: unknown) { this.onmessage?.({ data }); }
  }
  Object.defineProperty(globalThis, "Worker", { value: FakeWorker, configurable: true });
  try {
    const runtime = new WorkerRecognitionRuntime();
    const statuses: string[] = [];
    const preparing = runtime.prepare(message => statuses.push(message));
    const id = instance.messages[0].message.id;
    instance.reply({ id: id + 1, type: "status", message: "stale" });
    instance.reply({ id, type: "status", message: "checked" });
    instance.reply({ id, type: "ready" });
    await preparing;
    assert.deepEqual(statuses, ["checked"]);
    const pcm = new Float32Array(8000).fill(0.1);
    const inference = runtime.transcribe(pcm);
    assert.deepEqual(instance.messages[1].transfer, [pcm.buffer]);
    runtime.terminate();
    await assert.rejects(inference, /stopped or timed out/);
    instance.reply({ id: instance.messages[1].message.id, type: "transcript", text: "late result" });
    await assert.rejects(runtime.prepare(() => {}), /unavailable/);
    assert.equal(instance.terminations, 1);
  } finally {
    if (original) Object.defineProperty(globalThis, "Worker", original); else Reflect.deleteProperty(globalThis, "Worker");
  }
});

test("WorkerRecognitionRuntime forwards cache/download/import preparation and fences all canceled callbacks", async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "Worker");
  let instance!: FakeWorker;
  class FakeWorker {
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onerror: ((event: { preventDefault(): void }) => void) | null = null;
    onmessageerror: (() => void) | null = null;
    message?: { id: number; options: unknown };
    terminations = 0;
    constructor() { instance = this; }
    postMessage(message: { id: number; options: unknown }, transfer: Transferable[]) { this.message = message; assert.deepEqual(transfer, []); }
    terminate() { this.terminations++; }
  }
  Object.defineProperty(globalThis, "Worker", { value: FakeWorker, configurable: true });
  try {
    const options = [undefined, { source: "cache" } as const, { source: "download" } as const, { source: "import", file: new Blob(["PIVOICE1"]) } as const];
    for (const option of options) {
      const runtime = new WorkerRecognitionRuntime();
      const statuses: string[] = [];
      const prepare = runtime.prepare(message => statuses.push(message), option);
      assert.deepEqual(instance.message?.options, option ?? { source: "cache" });
      const late = instance.onmessage!;
      const lateError = instance.onerror!;
      runtime.terminate();
      await assert.rejects(prepare, /stopped/);
      assert.equal(instance.onmessage, null);
      assert.equal(instance.onerror, null);
      assert.equal(instance.onmessageerror, null);
      late({ data: { id: instance.message!.id, type: "status", message: "late" } });
      late({ data: { id: instance.message!.id, type: "ready" } });
      assert.deepEqual(statuses, []);
      assert.equal(instance.terminations, 1);
      // Even a callback already queued before termination cannot revive work.
      lateError({ preventDefault() {} });
      await assert.rejects(runtime.prepare(() => {}), /unavailable/);
    }
  } finally {
    if (original) Object.defineProperty(globalThis, "Worker", original); else Reflect.deleteProperty(globalThis, "Worker");
  }
});

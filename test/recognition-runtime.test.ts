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

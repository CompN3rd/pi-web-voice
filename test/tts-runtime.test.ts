import assert from "node:assert/strict";
import test from "node:test";
import { WorkerTtsRuntime, type TtsWorkerPort, type TtsRuntimeOptions } from "../src/browser/tts-runtime.js";
import { TTS_MAX_CHUNK_SAMPLES } from "../src/browser/tts-contract.js";

class FakeWorker implements TtsWorkerPort {
  onmessage: TtsWorkerPort["onmessage"] = null;
  onerror: TtsWorkerPort["onerror"] = null;
  onmessageerror: TtsWorkerPort["onmessageerror"] = null;
  messages: Record<string, unknown>[] = [];
  terminated = 0;
  throwPost = false;
  throwTerminate = false;
  postMessage(message: unknown): void { if (this.throwPost) throw Error("private url"); this.messages.push(message as Record<string, unknown>); }
  terminate(): void { this.terminated++; if (this.throwTerminate) throw Error("terminate"); }
  reply(value: object, request = this.messages.at(-1)!): void { this.onmessage?.({ data: { ...request, ...value } } as MessageEvent); }
}
function fixture(options: TtsRuntimeOptions = {}) {
  const worker = new FakeWorker();
  let constructions = 0;
  const runtime = new WorkerTtsRuntime({ pack: "pack", build: "build", worker: () => { constructions++; return worker; }, ...options });
  const prepare = async () => {
    const p = runtime.prepare(() => {});
    worker.reply({ type: "progress", progress: { phase: "initializing" } });
    worker.reply({ type: "ready" });
    await p;
  };
  const plan = async (count = 1) => { const p = runtime.plan("Hello."); worker.reply({ type: "planned", chunkCount: count }); assert.equal(await p, count); };
  return { worker, runtime, prepare, plan, constructions: () => constructions };
}

test("tts-runtime: inert construction, full handshake, pull chunks, fresh plan", async () => {
  const f = fixture();
  assert.equal(f.constructions(), 0);
  await f.prepare(); await f.plan(2);
  for (let index = 0; index < 2; index++) {
    const p = f.runtime.chunk(index);
    f.worker.reply({ type: "chunk", index, sampleRate: 24000, pcm: new Float32Array([0, .5, -1]) });
    assert.equal((await p).length, 3);
  }
  await f.plan(); f.runtime.terminate();
  assert.equal(f.worker.terminated, 1);
  assert.deepEqual(f.worker.messages.map(m => m.id), [1, 2, 3, 4, 5]);
});

test("tts-runtime: stale request and instance ignored; mismatch identity rejects reload", async () => {
  for (const mismatch of [{ version: 2 }, { pack: "stale" }, { build: "stale" }]) {
    const f = fixture(); const p = f.runtime.prepare(() => { throw Error("stale callback"); });
    f.worker.reply({ type: "progress", id: 0 });
    f.worker.reply({ type: "ready", instance: "old" });
    assert.equal(f.worker.terminated, 0);
    f.worker.reply({ type: "ready", ...mismatch });
    await assert.rejects(p, /reload-required/);
    assert.equal(f.worker.terminated, 1);
  }
});

test("tts-runtime: strict expected kind, readiness phase, progress metadata, sanitized errors", async () => {
  for (const response of [
    { type: "ready" }, { type: "planned", chunkCount: 1 }, { type: "error", code: "signed URL and text" },
    { type: "progress", progress: { phase: "checking", checkedBytes: -1, totalBytes: 10 } },
    { type: "progress", progress: { phase: "checking", checkedBytes: 2, totalBytes: Infinity } },
  ]) {
    const f = fixture(); const p = f.runtime.prepare(() => {}); f.worker.reply(response);
    await assert.rejects(p, /TTS protocol/);
    assert.equal(f.worker.terminated, 1);
  }
});

test("tts-runtime: reentrant callback termination settles exactly once and cannot resurrect", async () => {
  const f = fixture(); let statuses = 0;
  const p = f.runtime.prepare(() => { statuses++; f.runtime.terminate(); });
  const queued = f.worker.onmessage!;
  f.worker.reply({ type: "progress", progress: { phase: "initializing" } });
  queued({ data: { ...f.worker.messages[0], type: "ready" } } as MessageEvent);
  await assert.rejects(p, /stopped/);
  assert.equal(statuses, 1); assert.equal(f.worker.terminated, 1);
  await assert.rejects(f.runtime.plan("hello"), /not-ready/);
  await assert.rejects(f.runtime.prepare(() => {}), /stopped/);
});

test("tts-runtime: callback exception, constructor/post/error/messageerror failures settle", async () => {
  const bad = fixture({ worker: () => { throw Error("private"); } });
  await assert.rejects(bad.runtime.prepare(() => {}), /TTS worker/);
  for (const mode of ["post", "error", "messageerror", "callback"]) {
    const f = fixture(); f.worker.throwPost = mode === "post"; f.worker.throwTerminate = true;
    const p = f.runtime.prepare(() => { throw Error("private text"); });
    if (mode === "error") f.worker.onerror?.({ preventDefault() {} } as ErrorEvent);
    if (mode === "messageerror") f.worker.onmessageerror?.({} as MessageEvent);
    if (mode === "callback") f.worker.reply({ type: "progress", progress: { phase: "initializing" } });
    await assert.rejects(p, /TTS worker/);
    assert.equal(f.worker.onmessage, null);
  }
});

test("tts-runtime: busy refuses rather than queueing; bad chunk order invalidates runtime", async () => {
  const f = fixture(); const p = f.runtime.prepare(() => {});
  await assert.rejects(f.runtime.prepare(() => {}), /busy/);
  await assert.rejects(f.runtime.plan("hello"), /busy/);
  f.worker.reply({ type: "progress", progress: { phase: "initializing" } }); f.worker.reply({ type: "ready" }); await p;
  await f.plan(2);
  await assert.rejects(f.runtime.plan("new"), /busy/);
  await assert.rejects(f.runtime.chunk(1), /protocol/);
  assert.equal(f.worker.terminated, 1);
});

test("tts-runtime: strict PCM type/rate/order/amplitude/finite/size/storage validation", async () => {
  const subarray = new Float32Array([0, 0]).subarray(1);
  for (const fields of [
    { pcm: [] }, { pcm: new Float32Array() }, { pcm: new Float32Array([NaN]) }, { pcm: new Float32Array([Infinity]) },
    { pcm: new Float32Array([1.001]) }, { pcm: new Float32Array(TTS_MAX_CHUNK_SAMPLES + 1) }, { pcm: subarray },
    { sampleRate: 16000 }, { index: 1 }, { type: "ready" },
  ]) {
    const f = fixture(); await f.prepare(); await f.plan(); const p = f.runtime.chunk(0);
    f.worker.reply({ type: "chunk", index: 0, sampleRate: 24000, pcm: new Float32Array([0]), ...fields });
    await assert.rejects(p, /protocol/);
  }
});

test("tts-runtime: aggregate PCM ceiling", async () => {
  const f = fixture(); await f.prepare(); await f.plan(5);
  for (let i = 0; i < 5; i++) {
    const p = f.runtime.chunk(i);
    f.worker.reply({ type: "chunk", index: i, sampleRate: 24000, pcm: new Float32Array(TTS_MAX_CHUNK_SAMPLES) });
    if (i < 4) await p; else await assert.rejects(p, /protocol/);
  }
});

test("tts-runtime: preparation, initialization, inactivity and whole-job deadlines", async () => {
  for (const mode of ["prepare", "initialize", "inactivity", "job"] as const) {
    const f = fixture({ deadlines: { [mode]: 10 } });
    let p: Promise<unknown>;
    if (mode === "prepare" || mode === "initialize") {
      p = f.runtime.prepare(() => {});
      if (mode === "initialize") f.worker.reply({ type: "progress", progress: { phase: "initializing" } });
    } else {
      await f.prepare();
      p = f.runtime.plan("hello");
    }
    await assert.rejects(p, /timeout/); assert.equal(f.worker.terminated, 1);
  }
  const f = fixture({ deadlines: { job: 10 } }); await f.prepare(); await f.plan();
  await new Promise(resolve => setTimeout(resolve, 30));
  await assert.rejects(f.runtime.chunk(0), /not-ready/);
});

test("tts-runtime: progress never extends absolute preparation deadline", async () => {
  const f = fixture({ deadlines: { prepare: 15 } });
  const p = f.runtime.prepare(() => {});
  const timer = setInterval(() => f.worker.reply({ type: "progress", progress: { phase: "checking", checkedBytes: 0, totalBytes: 1 } }), 2);
  try { await assert.rejects(p, /timeout/); } finally { clearInterval(timer); }
});

import assert from "node:assert/strict";
import test from "node:test";
import { LocalRecognizer } from "../src/browser/audio.ts";
import type { PcmCapture } from "../src/browser/recognition-capture.ts";
import { MAX_PCM_SAMPLES } from "../src/browser/recognition-pcm.ts";
import { SpeechCoordinator } from "../src/browser/speech-coordinator.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture() {
  const loading = deferred<void>();
  const decoding = deferred<string>();
  const opening = deferred<PcmCapture>();
  const statuses: string[] = [];
  const transcripts: string[] = [];
  let samples!: (pcm: Float32Array) => void;
  let report!: (message: string) => void;
  let stopped = 0, terminated = 0, captures = 0, inferences = 0, inferredSamples = 0;
  const recognizer = LocalRecognizer.createForTest({ status: value => statuses.push(value), transcript: value => transcripts.push(value) }, {
    createRuntime: () => ({
      prepare: status => { report = status; return loading.promise; },
      transcribe: pcm => { assert.ok(stopped > 0, "tracks release before inference"); inferences++; inferredSamples = pcm.length; return decoding.promise; },
      terminate: () => { terminated++; },
    }),
    openCapture: async (_signal, receive) => { captures++; samples = receive; return opening.promise; },
  });
  return { recognizer, loading, decoding, opening, statuses, transcripts,
    samples: (pcm = new Float32Array(8000).fill(0.1)) => samples(pcm), report: (message: string) => report(message),
    counts: () => ({ stopped, terminated, captures, inferences, inferredSamples }),
    async ready() { const promise = recognizer.prepare(); loading.resolve(); await promise; },
    async start() { const promise = recognizer.start(); opening.resolve({ stop: () => { stopped++; } }); await promise; },
  };
}

test("LocalRecognizer requires explicit prepare without microphone; delivers one bounded final transcript", async () => {
  const f = fixture();
  await assert.rejects(f.recognizer.start(), /Prepare/);
  await f.ready();
  assert.equal(f.counts().captures, 0);
  assert.equal(f.recognizer.ready, true);
  await f.start();
  f.samples();
  const finish = f.recognizer.finish();
  assert.equal(f.counts().stopped, 1);
  await assert.rejects(f.recognizer.finish(), /not recording/);
  f.decoding.resolve(" x".repeat(5000));
  await finish;
  assert.equal(f.transcripts.length, 1);
  assert.equal(f.transcripts[0].length, 4000);
  assert.equal(f.recognizer.ready, true);
  f.recognizer.dispose();
});

test("LocalRecognizer cancel invalidates pending preparation and all late status/ready results", async () => {
  const f = fixture();
  const prepare = f.recognizer.prepare();
  f.recognizer.cancel();
  const statusCount = f.statuses.length;
  await assert.rejects(prepare, { name: "AbortError" });
  f.report("late downloading");
  f.loading.resolve();
  await Promise.resolve();
  assert.equal(f.statuses.length, statusCount);
  assert.equal(f.recognizer.ready, false);
  assert.equal(f.counts().terminated, 1);
});

test("LocalRecognizer late permission result is stopped, never ready or recording", async () => {
  const f = fixture();
  await f.ready();
  const start = f.recognizer.start();
  f.recognizer.cancel();
  await assert.rejects(start, { name: "AbortError" });
  let stopped = 0;
  f.opening.resolve({ stop: () => { stopped++; } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(stopped, 1);
  assert.equal(f.recognizer.state, "unprepared");
});

test("LocalRecognizer dispose terminates inference and fences late transcript, samples and callbacks", async () => {
  const f = fixture();
  await f.ready(); await f.start(); f.samples();
  const finish = f.recognizer.finish();
  f.recognizer.dispose();
  const statuses = f.statuses.length;
  await assert.rejects(finish, { name: "AbortError" });
  f.samples(); f.decoding.resolve("do not submit");
  await Promise.resolve();
  assert.deepEqual(f.transcripts, []);
  assert.equal(f.statuses.length, statuses);
  assert.equal(f.counts().terminated, 1);
  await assert.rejects(f.recognizer.prepare(), /disposed/);
});

test("LocalRecognizer silence never invokes inference", async () => {
  const f = fixture();
  await f.ready(); await f.start(); f.samples(new Float32Array(16000));
  await f.recognizer.finish();
  assert.equal(f.counts().inferences, 0);
  assert.equal(f.counts().stopped, 1);
  assert.deepEqual(f.transcripts, []);
  f.recognizer.dispose();
});

test("LocalRecognizer caps capture at 20 seconds and finishes automatically", async () => {
  const f = fixture();
  await f.ready(); await f.start();
  f.samples(new Float32Array(MAX_PCM_SAMPLES + 500).fill(0.1));
  assert.equal(f.counts().stopped, 1);
  assert.equal(f.counts().inferredSamples, MAX_PCM_SAMPLES);
  f.decoding.resolve("bounded");
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.transcripts, ["bounded"]);
  f.recognizer.dispose();
});

test("LocalRecognizer callback cancellation cannot resurrect preparation or transcript", async () => {
  let creates = 0;
  const recognizer = LocalRecognizer.createForTest({ status: () => recognizer.cancel(), transcript: () => assert.fail("unexpected transcript") }, {
    createRuntime: () => { creates++; throw new Error("must not create after cancel"); },
    openCapture: async () => { throw new Error("must not capture"); },
  });
  await assert.rejects(recognizer.prepare(), { name: "AbortError" });
  assert.equal(creates, 0);
  assert.equal(recognizer.ready, false);
});

test("LocalRecognizer runtime failure rejects and disables start until explicit reprepare", async () => {
  const f = fixture();
  const prepare = f.recognizer.prepare();
  f.loading.reject(new Error("Missing local pack"));
  await assert.rejects(prepare, /Missing local pack/);
  assert.equal(f.counts().terminated, 1);
  await assert.rejects(f.recognizer.start(), /Prepare/);
});

test("LocalRecognizer defaults to cache and forwards explicit preparation modes without microphone", async () => {
  for (const options of [undefined, { source: "download" } as const, { source: "import", file: new Blob(["PIVOICE1"]) } as const]) {
    let received: unknown;
    let terminated = 0;
    let report!: (message: string) => void;
    const loading = deferred<void>();
    const statuses: string[] = [];
    const recognizer = LocalRecognizer.createForTest({ status: message => statuses.push(message), transcript: () => assert.fail("no transcript") }, {
      createRuntime: () => ({
        prepare: (status, options) => { received = options; report = status; return loading.promise; },
        transcribe: async () => { throw new Error("no inference"); },
        terminate: () => { terminated++; },
      }),
      openCapture: async () => { throw new Error("no microphone"); },
    });
    const preparing = recognizer.prepare(options);
    assert.deepEqual(received, options ?? { source: "cache" });
    recognizer.cancel();
    const count = statuses.length;
    report("late preparation progress");
    loading.resolve();
    await assert.rejects(preparing, { name: "AbortError" });
    assert.equal(statuses.length, count);
    assert.equal(recognizer.ready, false);
    assert.equal(terminated, 1);
  }
});

test("LocalRecognizer pending canceled microphone retains page ownership until late tracks stop", async () => {
  const coordinator = new SpeechCoordinator(), opening = deferred<PcmCapture>();
  let stopped = 0;
  const recognizer = LocalRecognizer.createForTest({ status() {}, transcript() {} }, {
    coordinator,
    createRuntime: () => ({ prepare: async () => {}, transcribe: async () => "", terminate() {} }),
    openCapture: () => opening.promise,
  });
  await recognizer.prepare(); const starting = recognizer.start();
  const rejected = assert.rejects(starting, { name: "AbortError" });
  recognizer.cancel(); await rejected;
  const tts = { kind: "tts" as const, phase: "idle" as const, release: () => true };
  assert.throws(() => coordinator.acquire(tts), /busy/);
  await assert.rejects(recognizer.prepare(), /busy/);
  opening.resolve({ stop() { stopped++; } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(stopped, 1);
  coordinator.acquire(tts); assert.equal(coordinator.owns(tts), true);
});

test("LocalRecognizer pending microphone teardown deadline latches unsafe, including late throwing stop", async () => {
  const coordinator = new SpeechCoordinator(), opening = deferred<PcmCapture>();
  let deadline!: () => void, terminated = 0;
  const recognizer = LocalRecognizer.createForTest({ status() {}, transcript() {} }, {
    coordinator,
    setTimeout: ((callback: () => void, milliseconds: number) => {
      assert.equal(milliseconds, 5_000); deadline = callback; return {} as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout,
    clearTimeout: (() => {}) as typeof clearTimeout,
    createRuntime: () => ({ prepare: async () => {}, transcribe: async () => "", terminate() { terminated++; } }),
    openCapture: () => opening.promise,
  });
  await recognizer.prepare(); const starting = recognizer.start();
  const rejected = assert.rejects(starting);
  recognizer.cancel(); deadline(); await rejected;
  assert.equal(coordinator.safe, false); assert.equal(terminated, 1);
  opening.resolve({ stop() { throw new Error("uncertain tracks"); } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(coordinator.safe, false);
  await assert.rejects(recognizer.prepare(), /unsafe/);
});

test("LocalRecognizer stop failure still terminates weights and latches the shared audio gate", async () => {
  const coordinator = new SpeechCoordinator(); let terminated = 0;
  const recognizer = LocalRecognizer.createForTest({ status() {}, transcript() {} }, {
    coordinator,
    createRuntime: () => ({ prepare: async () => {}, transcribe: async () => "", terminate() { terminated++; } }),
    openCapture: async () => ({ stop() { throw new Error("stop"); } }),
  });
  await recognizer.prepare(); await recognizer.start(); recognizer.cancel();
  assert.equal(terminated, 1); assert.equal(coordinator.safe, false);
  await assert.rejects(recognizer.start(), /Prepare/);
});

test("LocalRecognizer owns resolved microphone before an intervening cancellation microtask", async () => {
  const coordinator = new SpeechCoordinator(), opening = deferred<PcmCapture>(); let stops = 0;
  const recognizer = LocalRecognizer.createForTest({ status() {}, transcript() {} }, {
    coordinator,
    createRuntime: () => ({ prepare: async () => {}, transcribe: async () => "", terminate() {} }),
    openCapture: () => opening.promise,
  });
  await recognizer.prepare(); const starting = recognizer.start();
  const rejected = assert.rejects(starting, { name: "AbortError" });
  void opening.promise.then(() => queueMicrotask(() => recognizer.cancel()));
  opening.resolve({ stop() { stops++; } });
  await rejected; await new Promise(resolve => setImmediate(resolve));
  assert.equal(stops, 1); assert.equal(recognizer.ready, false);
  assert.equal(coordinator.safe, true);
});

test("LocalRecognizer awaits capture close before inference and retains exclusion through cancel", async () => {
  const coordinator = new SpeechCoordinator(), closing = deferred<void>();
  let samples!: (pcm: Float32Array) => void, inferences = 0, stops = 0;
  const recognizer = LocalRecognizer.createForTest({ status() {}, transcript() {} }, {
    coordinator,
    createRuntime: () => ({ prepare: async () => {}, transcribe: async () => { inferences++; return "text"; }, terminate() {} }),
    openCapture: async (_signal, receive) => { samples = receive; return { stop() { stops++; return closing.promise; } }; },
  });
  await recognizer.prepare(); await recognizer.start(); samples(new Float32Array(8000).fill(0.1));
  const finish = recognizer.finish();
  assert.equal(stops, 1); assert.equal(inferences, 0);
  assert.throws(() => coordinator.acquire({ kind: "tts", phase: "idle", release: () => true }), /busy/);
  const rejected = assert.rejects(finish, { name: "AbortError" });
  recognizer.cancel(); await rejected;
  assert.throws(() => coordinator.acquire({ kind: "tts", phase: "idle", release: () => true }), /busy/);
  closing.resolve(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(inferences, 0); assert.equal(coordinator.safe, true);
  coordinator.acquire({ kind: "tts", phase: "idle", release: () => true });
});

test("LocalRecognizer rejects unsafe asynchronous close and never transcribes", async () => {
  const coordinator = new SpeechCoordinator(), closing = deferred<void>();
  let samples!: (pcm: Float32Array) => void;
  const recognizer = LocalRecognizer.createForTest({ status() {}, transcript() {} }, {
    coordinator,
    createRuntime: () => ({ prepare: async () => {}, transcribe: async () => { assert.fail("unsafe inference"); }, terminate() {} }),
    openCapture: async (_signal, receive) => { samples = receive; return { stop: () => closing.promise }; },
  });
  await recognizer.prepare(); await recognizer.start(); samples(new Float32Array(8000).fill(0.1));
  const finish = recognizer.finish();
  const rejected = assert.rejects(finish, { name: "CaptureTeardownError" });
  closing.reject(new Error("uncertain close")); await rejected;
  assert.equal(coordinator.safe, false); assert.equal(recognizer.ready, false);
});

test("LocalRecognizer pending capture close has a main-thread 5s deadline; late settlement cannot clear unsafe", async () => {
  const coordinator = new SpeechCoordinator(), closing = deferred<void>();
  const timers = new Map<ReturnType<typeof setTimeout>, () => void>();
  const recognizer = LocalRecognizer.createForTest({ status() {}, transcript() {} }, {
    coordinator,
    setTimeout: ((callback: () => void, milliseconds: number) => {
      assert.equal(milliseconds, 5_000); const key = {} as ReturnType<typeof setTimeout>; timers.set(key, callback); return key;
    }) as typeof setTimeout,
    clearTimeout: ((key: ReturnType<typeof setTimeout>) => { timers.delete(key); }) as typeof clearTimeout,
    createRuntime: () => ({ prepare: async () => {}, transcribe: async () => "", terminate() {} }),
    openCapture: async () => ({ stop: () => closing.promise }),
  });
  await recognizer.prepare(); await recognizer.start(); recognizer.cancel();
  assert.equal(coordinator.stopping, true);
  for (const callback of timers.values()) callback();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(coordinator.safe, false);
  closing.resolve(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(coordinator.safe, false); assert.equal(timers.size, 0);
  await assert.rejects(recognizer.prepare(), /unsafe/);
});

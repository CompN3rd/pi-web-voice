import assert from "node:assert/strict";
import test from "node:test";
import { LocalRecognizer } from "../src/browser/audio.ts";
import type { PcmCapture } from "../src/browser/recognition-capture.ts";
import { MAX_PCM_SAMPLES } from "../src/browser/recognition-pcm.ts";

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

import assert from "node:assert/strict";
import test from "node:test";
import { ModelSpeechOutput, type ModelSpeechStatus } from "../src/browser/speech-output.ts";
import { SpeechCoordinator } from "../src/browser/speech-coordinator.ts";
import { LocalRecognizer } from "../src/browser/audio.ts";
import { TTS_SAMPLE_RATE, TTS_MAX_CHUNK_SAMPLES, TTS_MAX_TOTAL_SAMPLES, type TtsRuntime } from "../src/browser/tts-contract.ts";

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
class Clock {
  timers = new Map<ReturnType<typeof setTimeout>, { callback: () => void; ms: number }>();
  setTimeout = (callback: () => void, ms: number) => {
    const key = {} as ReturnType<typeof setTimeout>;
    this.timers.set(key, { callback, ms }); return key;
  };
  clearTimeout = (key: ReturnType<typeof setTimeout>) => { this.timers.delete(key); };
  fire(ms: number) {
    const entries = [...this.timers.entries()].filter(([, timer]) => timer.ms === ms);
    assert.ok(entries.length, `expected ${ms}ms deadline`);
    for (const [key, timer] of entries) { this.timers.delete(key); timer.callback(); }
  }
}
class FakeSource {
  buffer: unknown = null;
  onended: (() => void) | null = null;
  started = 0; stopped = 0; disconnected = 0;
  throwStop = false; throwDisconnect = false;
  connect() {}
  start() { this.started++; }
  stop() { this.stopped++; if (this.throwStop) throw new Error("stop"); }
  disconnect() { this.disconnected++; if (this.throwDisconnect) throw new Error("disconnect"); }
  end() { this.onended?.(); }
}
class FakeAudio {
  state = "suspended";
  destination = {};
  onstatechange: (() => void) | null = null;
  sources: FakeSource[] = [];
  buffers: Array<{ channels: number; length: number; rate: number }> = [];
  resumes = 0; closes = 0; gainDisconnects = 0;
  throwGainDisconnect = false;
  resumeTask?: Promise<void>; closeTask?: Promise<void>;
  gain = { gain: { value: 1 }, connect() {}, disconnect: () => { this.gainDisconnects++; if (this.throwGainDisconnect) throw new Error("gain disconnect"); } };
  createGain() { return this.gain; }
  createBuffer(channels: number, length: number, rate: number) {
    this.buffers.push({ channels, length, rate }); return { copyToChannel() {} };
  }
  createBufferSource() { const source = new FakeSource(); this.sources.push(source); return source; }
  resume() {
    this.resumes++;
    if (this.resumeTask) return this.resumeTask.then(() => { if (this.state !== "closed") this.state = "running"; });
    this.state = "running"; return Promise.resolve();
  }
  close() {
    this.closes++;
    if (this.closeTask) return this.closeTask.then(() => { this.state = "closed"; });
    this.state = "closed"; return Promise.resolve();
  }
}
function fixture(coordinator = new SpeechCoordinator()) {
  const clock = new Clock(), audio = new FakeAudio();
  const statuses: ModelSpeechStatus[] = [], requested: number[] = [], texts: string[] = [];
  let creates = 0, contexts = 0, terminated = 0;
  const runtime: TtsRuntime = {
    prepare: async () => {}, plan: async text => { texts.push(text); return 1; },
    chunk: async index => { requested.push(index); return new Float32Array(240).fill(0.25); },
    terminate: () => { terminated++; },
  };
  let observer: ((status: ModelSpeechStatus) => void) | undefined;
  const output = new ModelSpeechOutput(status => { statuses.push(status); observer?.(status); }, () => { creates++; return runtime; }, {
    coordinator, createAudioContext: () => { contexts++; return audio as unknown as AudioContext; },
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
  });
  return { output, runtime, clock, audio, statuses, requested, texts, coordinator,
    observe(callback: (status: ModelSpeechStatus) => void) { observer = callback; },
    counts: () => ({ creates, contexts, terminated }),
    async ready() { await output.prepare(); output.setEnabled(true); },
  };
}

test("ModelSpeechOutput is inert, separate preparation/enablement, never consults OS speech", async () => {
  Object.defineProperty(globalThis, "speechSynthesis", { configurable: true, get() { assert.fail("OS speech accessed"); } });
  Object.defineProperty(globalThis, "SpeechSynthesisUtterance", { configurable: true, get() { assert.fail("OS speech accessed"); } });
  try {
    const f = fixture();
    assert.deepEqual(f.counts(), { creates: 0, contexts: 0, terminated: 0 });
    assert.deepEqual(f.statuses, []);
    await assert.rejects(f.output.speak("hello"), /Enable and prepare/);
    await f.output.prepare();
    assert.equal(f.output.ready, true); assert.equal(f.output.enabled, false);
    await assert.rejects(f.output.speak("hello"));
    assert.equal(f.counts().contexts, 0);
    f.output.setEnabled(true);
    const speaking = f.output.speak("hello");
    assert.equal(f.audio.resumes, 1, "resume occurs in the direct gesture call, not a continuation");
    await flush(); f.audio.sources[0].end(); await speaking;
    assert.equal(f.output.ready, true); assert.equal(f.counts().terminated, 0);
    assert.deepEqual(f.audio.buffers, [{ channels: 1, length: 240, rate: TTS_SAMPLE_RATE }]);
    assert.equal(f.audio.gain.gain.value, 0);
    assert.equal(f.audio.sources[0].buffer, null);
    assert.equal(await f.output.dispose(), true);
  } finally { delete (globalThis as Record<string, unknown>).speechSynthesis; delete (globalThis as Record<string, unknown>).SpeechSynthesisUtterance; }
});

test("ModelSpeechOutput validates exact prefix and rejects repeated clicks without replacement/replay", async () => {
  const f = fixture(); await f.ready();
  for (const text of ["", " \n", "a".repeat(1001)]) await assert.rejects(f.output.speak(text), /prefix/);
  assert.equal(f.audio.resumes, 0);
  const job = f.output.speak("a".repeat(1000)); await flush();
  await assert.rejects(f.output.speak("second"), /busy/);
  assert.equal(f.audio.sources.length, 1); assert.equal(f.audio.gain.gain.value, 0.8);
  const rejected = assert.rejects(job, { name: "AbortError" });
  await f.output.stop(); await rejected;
  assert.equal(f.output.enabled, true); assert.equal(f.output.ready, false);
  await assert.rejects(f.output.speak("no auto reload"));
  assert.equal(f.counts().creates, 1); assert.equal(f.texts.length, 1);
  assert.equal(f.clock.timers.size, 0);
});

test("ModelSpeechOutput stop cancels pending prepare, suppresses late progress and releases weights", async () => {
  const f = fixture(), loading = deferred<void>();
  let progress!: Parameters<TtsRuntime["prepare"]>[0];
  let options: unknown;
  f.runtime.prepare = (status, value) => { progress = status; options = value; return loading.promise; };
  const job = f.output.prepare({ source: "download" });
  assert.deepEqual(options, { source: "download" });
  const rejected = assert.rejects(job, { name: "AbortError" });
  await f.output.stop(); await rejected;
  const count = f.statuses.length;
  progress({ phase: "initializing" }); loading.resolve(); await flush();
  assert.equal(f.statuses.length, count); assert.equal(f.output.ready, false);
  assert.equal(f.counts().terminated, 1); assert.equal(f.clock.timers.size, 0);
});

test("ModelSpeechOutput reentrant status cancellation cannot resurrect prepare or playback", async () => {
  for (const phase of ["preparing", "synthesizing", "playing"] as const) {
    const f = fixture();
    if (phase !== "preparing") await f.ready();
    f.observe(status => { if (status.code === phase) void f.output.dispose(); });
    const job = phase === "preparing" ? f.output.prepare() : f.output.speak("hello");
    await assert.rejects(job, { name: "AbortError" }); await flush();
    assert.equal(f.output.state, "disposed"); assert.equal(f.output.enabled, false);
    assert.equal(f.output.ready, false); assert.equal(f.clock.timers.size, 0);
    if (phase === "preparing") assert.equal(f.counts().creates, 0);
    for (const source of f.audio.sources) { assert.equal(source.stopped, 1); assert.equal(source.buffer, null); }
  }
});

test("ModelSpeechOutput stop waits for pending resume and close; late callbacks cannot start sources", async () => {
  const f = fixture(), resume = deferred<void>(), close = deferred<void>();
  f.audio.resumeTask = resume.promise; f.audio.closeTask = close.promise;
  await f.ready(); const job = f.output.speak("hello");
  const rejected = assert.rejects(job, { name: "AbortError" });
  let settled = false;
  const stopping = f.output.stop().then(safe => { settled = true; return safe; });
  assert.equal(f.output.state, "stopping"); await flush(); assert.equal(settled, false);
  await assert.rejects(f.output.prepare(), /busy/);
  close.resolve(); await flush(); assert.equal(settled, false);
  resume.resolve(); assert.equal(await stopping, true); await rejected;
  assert.equal(f.audio.sources.length, 0); assert.equal(f.output.state, "unprepared");
  assert.equal(f.clock.timers.size, 0);
});

test("ModelSpeechOutput rejected resume is recoverable only after explicit preparation/fresh gesture", async () => {
  const f = fixture(); f.audio.resumeTask = Promise.reject(new Error("autoplay"));
  // Attach before awaiting preparation to keep this intentionally rejected fake observed.
  void f.audio.resumeTask.catch(() => {});
  await f.ready(); await assert.rejects(f.output.speak("hello"), /autoplay/);
  assert.equal(f.output.state, "failed"); assert.equal(f.output.cancellationSafe, true);
  assert.equal(f.audio.sources.length, 0); assert.equal(f.counts().terminated, 1);
  await assert.rejects(f.output.speak("never retry")); assert.equal(f.audio.resumes, 1);
});

test("ModelSpeechOutput never-settling resume or close latches document unsafe after bounded teardown", async () => {
  for (const pending of ["resume", "close"] as const) {
    const coordinator = new SpeechCoordinator(), f = fixture(coordinator), task = deferred<void>();
    if (pending === "resume") f.audio.resumeTask = task.promise; else f.audio.closeTask = task.promise;
    await f.ready(); const job = f.output.speak("hello"); await flush();
    const rejected = assert.rejects(job);
    const stopping = f.output.dispose();
    f.clock.fire(5_000);
    assert.equal(await stopping, false); await rejected;
    const remount = fixture(coordinator);
    assert.equal(remount.output.cancellationSafe, false);
    await assert.rejects(remount.output.prepare(), /unsafe/);
    remount.output.setEnabled(true); assert.equal(remount.output.enabled, false);
    task.resolve(); await flush();
    assert.equal(f.output.cancellationSafe, false); assert.equal(remount.output.cancellationSafe, false);
    for (const source of f.audio.sources) source.end();
    assert.equal(f.output.state, "disposed"); assert.equal(f.clock.timers.size, 0);
  }
});

test("ModelSpeechOutput rejected/throwing close latches unsafe even when resume/ended arrive later", async () => {
  for (const mode of ["reject", "throw"] as const) {
    const f = fixture(); await f.ready();
    if (mode === "reject") f.audio.closeTask = Promise.reject(new Error("close"));
    else f.audio.close = () => { f.audio.closes++; throw new Error("close"); };
    void f.audio.closeTask?.catch(() => {});
    const job = f.output.speak("hello"); await flush();
    const late = f.audio.sources[0].onended;
    const rejected = assert.rejects(job);
    assert.equal(await f.output.stop(), false); await rejected;
    late?.(); assert.equal(f.output.cancellationSafe, false);
    assert.equal(f.audio.sources[0].buffer, null);
  }
});

test("ModelSpeechOutput independently attempts mute, stop, disconnect, close and termination despite throws", async () => {
  const f = fixture(); await f.ready(); const job = f.output.speak("hello"); await flush();
  const source = f.audio.sources[0]; source.throwStop = true; source.throwDisconnect = true;
  f.audio.throwGainDisconnect = true;
  let terminated = 0; f.runtime.terminate = () => { terminated++; throw new Error("terminate"); };
  const rejected = assert.rejects(job);
  assert.equal(await f.output.stop(), false); await rejected;
  assert.equal(terminated, 1); assert.equal(f.audio.gain.gain.value, 0);
  assert.equal(source.stopped, 1); assert.equal(source.disconnected, 1); assert.equal(source.buffer, null);
  assert.equal(f.audio.closes, 1); assert.equal(f.clock.timers.size, 0);
});

test("ModelSpeechOutput uses one source plus one in-flight chunk and reports later failures as partial", async () => {
  const f = fixture(), second = deferred<Float32Array>();
  f.runtime.plan = async () => 3;
  f.runtime.chunk = async index => { f.requested.push(index); return index === 0 ? new Float32Array(240) : second.promise; };
  await f.ready(); const job = f.output.speak("one two three"); await flush();
  assert.deepEqual(f.requested, [0, 1]); assert.equal(f.audio.sources.length, 1);
  assert.equal(f.output.status.playing, true); assert.equal(f.output.status.synthesizing, true);
  const rejected = assert.rejects(job, /later chunk/);
  second.reject(new Error("later chunk")); await rejected;
  assert.deepEqual(f.requested, [0, 1]); assert.equal(f.audio.sources[0].stopped, 1);
  assert.equal(f.output.status.partialPlayback, true); assert.equal(f.output.status.code, "partial-playback");
  assert.equal(f.counts().terminated, 1);
});

test("ModelSpeechOutput queued PCM is not scheduled until previous owned source ends", async () => {
  const f = fixture(); f.runtime.plan = async () => 3;
  await f.ready(); const job = f.output.speak("one two three"); await flush();
  assert.deepEqual(f.requested, [0, 1]); assert.equal(f.audio.sources.length, 1);
  f.audio.sources[0].end(); await flush();
  assert.deepEqual(f.requested, [0, 1, 2]); assert.equal(f.audio.sources.length, 2);
  assert.equal(f.audio.sources[0].buffer, null);
  f.audio.sources[1].end(); await flush(); assert.equal(f.audio.sources.length, 3);
  f.audio.sources[2].end(); await job;
  assert.equal(f.output.status.code, "finished"); assert.equal(f.clock.timers.size, 0);
  await f.output.dispose();
});

test("ModelSpeechOutput rejects invalid PCM before any source is created", async () => {
  for (const pcm of [new Float32Array(0), new Float32Array([NaN]), new Float32Array([Infinity]), new Float32Array([1.01]), new Float32Array(TTS_MAX_CHUNK_SAMPLES + 1), new Int16Array([1])]) {
    const f = fixture(); f.runtime.chunk = async () => pcm as Float32Array;
    await f.ready(); await assert.rejects(f.output.speak("hello"), /PCM/);
    assert.equal(f.audio.sources.length, 0); assert.equal(f.output.ready, false);
    assert.equal(f.output.status.partialPlayback, false); assert.equal(f.clock.timers.size, 0);
  }
});

test("ModelSpeechOutput enforces whole PCM budget and chunk-count bounds", async () => {
  for (const count of [0, 33, NaN, 1.5]) {
    const f = fixture(); f.runtime.plan = async () => count;
    await f.ready(); await assert.rejects(f.output.speak("hello"), /chunk count/);
    assert.equal(f.requested.length, 0); assert.equal(f.audio.sources.length, 0);
  }
  const f = fixture(); f.runtime.plan = async () => 5;
  f.runtime.chunk = async () => new Float32Array(TTS_MAX_CHUNK_SAMPLES);
  await f.ready(); const job = f.output.speak("long");
  const rejected = assert.rejects(job, /PCM/);
  for (let index = 0; index < TTS_MAX_TOTAL_SAMPLES / TTS_MAX_CHUNK_SAMPLES - 1; index++) {
    await flush(); f.audio.sources[index].end();
  }
  await rejected; assert.equal(f.output.status.partialPlayback, true);
  assert.ok(f.audio.sources.length <= 4);
});

test("ModelSpeechOutput main-thread preparation, initialization, inactivity and absolute job deadlines settle", async () => {
  for (const deadline of ["prepare", "initialize", "plan", "chunk", "resume", "job"] as const) {
    const f = fixture(), blocked = deferred<never>();
    let job: Promise<void>;
    if (deadline === "prepare" || deadline === "initialize") {
      f.runtime.prepare = progress => { if (deadline === "initialize") progress({ phase: "initializing" }); return blocked.promise; };
      job = f.output.prepare();
    } else {
      await f.ready();
      if (deadline === "plan") f.runtime.plan = () => blocked.promise;
      if (deadline === "chunk") f.runtime.chunk = () => blocked.promise;
      if (deadline === "resume") f.audio.resumeTask = blocked.promise;
      job = f.output.speak("hello"); await flush();
    }
    const rejected = assert.rejects(job, /deadline/);
    f.clock.fire(deadline === "initialize" ? 60_000 : ["plan", "chunk", "resume"].includes(deadline) ? 120_000 : 300_000);
    await flush();
    if (deadline === "resume") f.clock.fire(5_000);
    await rejected;
    assert.equal(f.output.ready, false); assert.equal(f.counts().terminated, 1); assert.equal(f.clock.timers.size, 0);
  }
});

test("ModelSpeechOutput interruption stops the job; late running/ended cannot resume it", async () => {
  const f = fixture(); await f.ready(); const job = f.output.speak("hello"); await flush();
  const late = f.audio.sources[0].onended;
  const rejected = assert.rejects(job, /interrupted/);
  f.audio.state = "suspended"; f.audio.onstatechange?.(); await rejected;
  f.audio.state = "running"; f.audio.onstatechange?.(); late?.();
  assert.equal(f.audio.sources.length, 1); assert.equal(f.output.ready, false);
  assert.equal(f.output.status.partialPlayback, true);
});

test("ModelSpeechOutput/LocalRecognizer share residency, preserve drafts and require explicit reprepare", async () => {
  const coordinator = new SpeechCoordinator(), f = fixture(coordinator);
  const statuses: string[] = []; let evictions = 0, terminated = 0, captures = 0;
  const draft = "keep this typed instruction";
  const recognizer = LocalRecognizer.createForTest({ status: message => statuses.push(message), transcript: () => assert.fail(), unprepared: () => { evictions++; } }, {
    coordinator,
    createRuntime: () => ({ prepare: async () => {}, transcribe: async () => "", terminate: () => { terminated++; } }),
    openCapture: async () => { captures++; return { stop() {} }; },
  });
  await recognizer.prepare(); await f.ready();
  assert.equal(recognizer.ready, false); assert.equal(evictions, 1); assert.equal(terminated, 1);
  assert.match(statuses.at(-1)!, /unprepared/); assert.equal(draft, "keep this typed instruction");
  await assert.rejects(recognizer.start(), /Prepare/); assert.equal(captures, 0);
  const speaking = f.output.speak("hello"); await flush();
  const rejected = assert.rejects(speaking);
  await recognizer.prepare(); await rejected;
  assert.equal(f.output.ready, false); assert.equal(f.output.enabled, true);
  await recognizer.start();
  await assert.rejects(f.output.prepare(), /busy/);
  assert.equal(recognizer.state, "recording"); assert.equal(captures, 1);
  recognizer.dispose(); await f.output.dispose();
});

test("ModelSpeechOutput cannot acquire during recognition prepare/start/transcribe; no implicit interruption", async () => {
  for (const phase of ["prepare", "start", "transcribe"] as const) {
    const coordinator = new SpeechCoordinator(), f = fixture(coordinator), blocked = deferred<never>();
    let samples!: (pcm: Float32Array) => void;
    const recognizer = LocalRecognizer.createForTest({ status() {}, transcript() {} }, {
      coordinator,
      createRuntime: () => ({ prepare: () => phase === "prepare" ? blocked.promise : Promise.resolve(), transcribe: () => blocked.promise, terminate() {} }),
      openCapture: async (_signal, receive) => { samples = receive; return phase === "start" ? blocked.promise : { stop() {} }; },
    });
    let pending: Promise<void>;
    if (phase === "prepare") pending = recognizer.prepare();
    else {
      await recognizer.prepare();
      if (phase === "start") pending = recognizer.start();
      else { await recognizer.start(); samples(new Float32Array(8000).fill(0.1)); pending = recognizer.finish(); }
    }
    await assert.rejects(f.output.prepare(), /busy/);
    assert.equal(f.counts().creates, 0);
    const rejected = assert.rejects(pending);
    recognizer.cancel(); blocked.reject(new Error("canceled fake")); await rejected; await flush();
    assert.equal(coordinator.safe, true);
    await f.output.dispose();
  }
});

test("ModelSpeechOutput ready callback cancellation rejects prepare instead of publishing stale success", async () => {
  const f = fixture();
  f.observe(status => { if (status.code === "ready") void f.output.dispose(); });
  await assert.rejects(f.output.prepare(), { name: "AbortError" }); await flush();
  assert.equal(f.output.state, "disposed"); assert.equal(f.counts().terminated, 1);
});

test("ModelSpeechOutput runtime/status synchronous cancellation is fenced before await registration", async () => {
  for (const phase of ["prepare", "plan", "chunk"] as const) {
    const f = fixture();
    if (phase === "prepare") f.runtime.prepare = async () => { void f.output.stop(); };
    else {
      await f.ready();
      if (phase === "plan") f.runtime.plan = async () => { void f.output.stop(); return 1; };
      else f.runtime.chunk = async () => { void f.output.stop(); return new Float32Array(240); };
    }
    await assert.rejects(phase === "prepare" ? f.output.prepare() : f.output.speak("hello"), { name: "AbortError" });
    await flush(); assert.equal(f.audio.sources.length, 0); assert.equal(f.output.state, "unprepared");
    assert.equal(f.counts().terminated, 1); assert.equal(f.clock.timers.size, 0);
  }
});

test("ModelSpeechOutput source construction/start errors clean the partially built graph", async () => {
  for (const phase of ["buffer", "source", "connect", "start"] as const) {
    const f = fixture(); await f.ready();
    if (phase === "buffer") f.audio.createBuffer = () => { throw new Error("buffer failure"); };
    else if (phase === "source") f.audio.createBufferSource = () => { throw new Error("source failure"); };
    else {
      const original = f.audio.createBufferSource.bind(f.audio);
      f.audio.createBufferSource = () => {
        const source = original();
        source[phase] = () => { throw new Error(`${phase} failure`); };
        return source;
      };
    }
    await assert.rejects(f.output.speak("hello"), /failure/);
    assert.equal(f.audio.closes, 1); assert.equal(f.counts().terminated, 1);
    assert.equal(f.audio.gain.gain.value, 0); assert.equal(f.output.ready, false);
    for (const source of f.audio.sources) { assert.equal(source.stopped, 1); assert.equal(source.buffer, null); }
  }
});

test("ModelSpeechOutput two controllers cannot prepare together; idle handoff evicts only old weights", async () => {
  const coordinator = new SpeechCoordinator(), first = fixture(coordinator), second = fixture(coordinator);
  const loading = deferred<void>(); first.runtime.prepare = () => loading.promise;
  const preparation = first.output.prepare();
  await assert.rejects(second.output.prepare(), /busy/); assert.equal(second.counts().creates, 0);
  loading.resolve(); await preparation; first.output.setEnabled(true);
  await second.ready();
  assert.equal(first.output.ready, false); assert.equal(first.output.enabled, true);
  assert.equal(first.counts().terminated, 1); assert.equal(second.output.ready, true);
  await first.output.stop(); assert.equal(second.output.ready, true);
  await second.output.dispose();
});

test("ModelSpeechOutput canceled acquire stays canceled while the coordinator retains old teardown", async () => {
  const coordinator = new SpeechCoordinator(), first = fixture(coordinator), second = fixture(coordinator);
  const closing = deferred<void>(); first.audio.closeTask = closing.promise;
  await first.ready(); const speaking = first.output.speak("hello"); await flush();
  const rejectedSpeech = assert.rejects(speaking);
  // Recognition is allowed to interrupt TTS. Cancel this acquisition before close settles.
  const pendingOwner = { kind: "recognition" as const, phase: "preparing" as const, release: () => true };
  const acquiring = coordinator.acquire(pendingOwner)!;
  const rejectedAcquire = assert.rejects(acquiring, { name: "AbortError" });
  coordinator.release(pendingOwner);
  await assert.rejects(second.output.prepare(), /busy/);
  closing.resolve(); await rejectedAcquire; await rejectedSpeech;
  assert.equal(first.output.ready, false);
  await second.ready(); assert.equal(second.output.ready, true);
  await second.output.dispose();
});

test("ModelSpeechOutput pending resume rejection after Stop settles safely without reviving the job", async () => {
  const f = fixture(), resume = deferred<void>(); f.audio.resumeTask = resume.promise;
  await f.ready(); const job = f.output.speak("hello"), rejected = assert.rejects(job);
  const stopping = f.output.stop(); resume.reject(new Error("late denial"));
  assert.equal(await stopping, true); await rejected;
  assert.equal(f.audio.sources.length, 0); assert.equal(f.output.ready, false);
  assert.equal(f.clock.timers.size, 0);
});

test("ModelSpeechOutput observer exceptions cannot interrupt shutdown cleanup", async () => {
  const f = fixture(); await f.ready(); const job = f.output.speak("hello"); await flush();
  f.observe(() => { throw new Error("broken UI observer"); });
  const rejected = assert.rejects(job);
  assert.equal(await f.output.dispose(), true); await rejected;
  assert.equal(f.audio.sources[0].stopped, 1); assert.equal(f.audio.closes, 1);
  assert.equal(f.output.state, "disposed"); assert.equal(f.output.enabled, false);
});

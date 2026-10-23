import type { SpeechPreparation } from "./speech-assets.js";
import { pageSpeechCoordinator, type SpeechCoordinator, type SpeechOwner } from "./speech-coordinator.js";
import {
  TTS_INACTIVITY_MS, TTS_INITIALIZE_MS, TTS_JOB_MS, TTS_MAX_CHUNKS, TTS_MAX_TEXT,
  TTS_MAX_TOTAL_SAMPLES, TTS_PREPARE_MS, TTS_SAMPLE_RATE, TTS_TEARDOWN_MS,
  validTtsPcm, type TtsProgress, type TtsRuntime,
} from "./tts-contract.js";

export type ModelSpeechState = "unprepared" | "preparing" | "ready" | "synthesizing" | "playing" | "stopping" | "failed" | "disposed";
export interface ModelSpeechStatus {
  state: ModelSpeechState;
  ready: boolean;
  enabled: boolean;
  safe: boolean;
  synthesizing: boolean;
  playing: boolean;
  partialPlayback: boolean;
  code: "unprepared" | "preparing" | "ready" | "synthesizing" | "playing" | "finished" | "stopping" | "stopped" | "failed" | "partial-playback" | "unsafe" | "disposed";
  progress?: TtsProgress;
}
export interface ModelSpeechOutputDependencies {
  coordinator: SpeechCoordinator;
  createAudioContext(): AudioContext;
  setTimeout(callback: () => void, milliseconds: number): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
}
interface Operation { epoch: number; abort: AbortController; timers: Set<ReturnType<typeof setTimeout>>; }

/** Inert, explicitly enabled model playback. The caller owns source/context identity and must
 * stop on its invalidation; stop releases weights, while setEnabled(false) also revokes permission.
 * speak accepts the exact labelled prefix (<=1000 UTF-16 units), never silently truncates/replays it.
 */
export class ModelSpeechOutput {
  private readonly dependencies: ModelSpeechOutputDependencies;
  private readonly owner: SpeechOwner;
  private currentState: ModelSpeechState = "unprepared";
  private permission = false;
  private disposed = false;
  private epoch = 0;
  private operation?: Operation;
  private runtime?: TtsRuntime;
  private context?: AudioContext;
  private gain?: GainNode;
  private resume?: Promise<void>;
  private readonly sources = new Set<AudioBufferSourceNode>();
  private stopping?: Promise<boolean>;
  private closing?: Promise<boolean>;
  private generating = false;
  private played = false;
  private code: ModelSpeechStatus["code"] = "unprepared";
  private progress?: TtsProgress;

  constructor(private readonly onStatus: (status: ModelSpeechStatus) => void,
    private readonly createRuntime: () => TtsRuntime, dependencies: Partial<ModelSpeechOutputDependencies> = {}) {
    this.dependencies = { coordinator: pageSpeechCoordinator(), createAudioContext: () => new AudioContext(), setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds), clearTimeout: timer => clearTimeout(timer), ...dependencies };
    const controller = this;
    this.owner = {
      kind: "tts",
      get phase() {
        if (controller.currentState === "preparing") return "preparing";
        if (controller.stopping || controller.currentState === "stopping") return "stopping";
        return controller.operation ? "active" : "idle";
      },
      release: () => this.stop(),
    };
  }

  get state(): ModelSpeechState { return this.currentState; }
  get ready(): boolean { return this.currentState === "ready" && this.cancellationSafe; }
  get enabled(): boolean { return this.permission; }
  get cancellationSafe(): boolean { return this.dependencies.coordinator.safe; }
  get status(): ModelSpeechStatus {
    return { state: this.state, ready: this.ready, enabled: this.enabled, safe: this.cancellationSafe,
      synthesizing: this.generating, playing: this.sources.size > 0, partialPlayback: this.played && this.code === "partial-playback",
      code: this.cancellationSafe ? this.code : "unsafe", ...(this.progress ? { progress: { ...this.progress } } : {}) };
  }
  private publish(code: ModelSpeechStatus["code"]): void {
    this.code = code;
    // UI exceptions must not interrupt teardown or retain an audio resource.
    try { this.onStatus(this.status); } catch { /* Observer has no audio authority. */ }
  }
  setEnabled(enabled: boolean): void {
    this.permission = enabled && !this.disposed && this.cancellationSafe;
    if (!enabled) void this.stop();
    else this.publish(this.code);
  }
  private begin(): Operation {
    const operation = { epoch: ++this.epoch, abort: new AbortController(), timers: new Set<ReturnType<typeof setTimeout>>() };
    this.operation = operation;
    return operation;
  }
  private check(operation: Operation): void {
    if (this.disposed || operation.epoch !== this.epoch || this.operation !== operation) throw new DOMException("Speech canceled", "AbortError");
    operation.abort.signal.throwIfAborted();
    if (!this.cancellationSafe) throw new Error("Audio unsafe; reload this page");
  }
  private deadline(operation: Operation, milliseconds: number): void {
    const timer = this.dependencies.setTimeout(() => {
      operation.timers.delete(timer);
      if (this.operation === operation) operation.abort.abort(new Error("Speech deadline exceeded"));
    }, milliseconds);
    operation.timers.add(timer);
  }
  private clear(operation: Operation): void {
    for (const timer of operation.timers) this.dependencies.clearTimeout(timer);
    operation.timers.clear();
  }
  private async pending<T>(task: Promise<T>, operation: Operation, milliseconds?: number): Promise<T> {
    void task.catch(() => {});
    let listener: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      this.check(operation);
      return await Promise.race([task, new Promise<never>((_, reject) => {
        listener = () => reject(operation.abort.signal.reason);
        operation.abort.signal.addEventListener("abort", listener, { once: true });
        if (operation.abort.signal.aborted) listener();
        if (milliseconds !== undefined) {
          timer = this.dependencies.setTimeout(() => reject(new Error("Speech inactivity deadline exceeded")), milliseconds);
          operation.timers.add(timer);
        }
      })]);
    } finally {
      if (listener) operation.abort.signal.removeEventListener("abort", listener);
      if (timer !== undefined) { this.dependencies.clearTimeout(timer); operation.timers.delete(timer); }
    }
  }

  async prepare(options: SpeechPreparation = { source: "cache" }): Promise<void> {
    if (this.disposed || this.stopping || this.operation || !this.cancellationSafe) throw new Error("Speech is busy, disposed or unsafe");
    if (this.ready) return;
    const operation = this.begin();
    this.currentState = "preparing";
    this.played = false;
    this.deadline(operation, TTS_PREPARE_MS);
    try {
      const acquisition = this.dependencies.coordinator.acquire(this.owner);
      if (acquisition) await this.pending(acquisition, operation);
      this.check(operation);
      this.publish("preparing");
      this.check(operation);
      const runtime = this.createRuntime();
      // Defend against synchronous factory cancellation before assigning the resource.
      try { this.check(operation); } catch (error) {
        try { runtime.terminate(); } catch { this.dependencies.coordinator.latchUnsafe(); }
        throw error;
      }
      this.runtime = runtime;
      let initializing = false;
      await this.pending(runtime.prepare(progress => {
        if (this.operation !== operation || operation.abort.signal.aborted) return;
        if (progress.phase !== "checking" && progress.phase !== "initializing") return;
        this.progress = { phase: progress.phase };
        for (const key of ["checkedBytes", "totalBytes"] as const) {
          const value = progress[key];
          if (Number.isSafeInteger(value) && value! >= 0 && value! <= 128_000_000) this.progress[key] = value;
        }
        if (progress.phase === "initializing" && !initializing) { initializing = true; this.deadline(operation, TTS_INITIALIZE_MS); }
        this.publish("preparing");
      }, options), operation);
      this.check(operation);
      this.clear(operation);
      this.operation = undefined;
      this.progress = undefined;
      this.currentState = "ready";
      this.publish("ready");
      if (this.epoch !== operation.epoch || this.disposed) throw new DOMException("Speech canceled", "AbortError");
    } catch (error) { await this.fail(operation); throw error; }
  }

  /** Invoke directly in a user gesture: AudioContext construction/resume precedes the first await. */
  async speak(text: string): Promise<void> {
    if (!this.ready || !this.enabled || this.operation || this.stopping || !this.dependencies.coordinator.owns(this.owner)) throw new Error("Enable and prepare speech before playback; busy requests are not queued");
    if (typeof text !== "string" || !text.trim() || text.length > TTS_MAX_TEXT) throw new Error("Select a nonempty playback prefix of at most 1000 characters");
    const operation = this.begin();
    this.currentState = "synthesizing";
    this.played = false;
    this.deadline(operation, TTS_JOB_MS);
    try {
      const context = this.dependencies.createAudioContext();
      try { this.check(operation); } catch (error) {
        // A factory returning a resource after synchronous cancellation cannot be certified safe.
        this.dependencies.coordinator.latchUnsafe();
        try { void context.close().catch(() => {}); } catch { /* Already latched. */ }
        throw error;
      }
      this.context = context;
      const gain = this.gain = context.createGain();
      gain.gain.value = 0.8;
      gain.connect(context.destination);
      const resume = this.resume = Promise.resolve(context.resume());
      void resume.catch(() => {});
      this.publish("synthesizing");
      await this.pending(resume, operation, TTS_INACTIVITY_MS);
      this.check(operation);
      if (context.state !== "running") throw new Error("Audio is not running; tap Speak again after preparation");
      context.onstatechange = () => {
        if (this.operation === operation && context.state !== "running") operation.abort.abort(new Error("Audio interrupted"));
      };
      const count = await this.pending(this.runtime!.plan(text), operation, TTS_INACTIVITY_MS);
      this.check(operation);
      if (!Number.isSafeInteger(count) || count < 1 || count > TTS_MAX_CHUNKS) throw new Error("Invalid speech chunk count");
      let total = 0;
      const chunk = async (index: number): Promise<Float32Array> => {
        this.check(operation);
        this.generating = true;
        const pcm = await this.pending(this.runtime!.chunk(index), operation, TTS_INACTIVITY_MS);
        this.check(operation);
        if (!validTtsPcm(pcm) || total + pcm.length > TTS_MAX_TOTAL_SAMPLES) throw new Error("Invalid or excessive speech PCM");
        total += pcm.length;
        this.generating = false;
        return pcm;
      };
      let pcm = await chunk(0);
      for (let index = 0; index < count; index++) {
        this.check(operation);
        const ended = this.play(pcm, operation, context, gain);
        pcm = new Float32Array(0);
        // Exactly one owned source and at most one requested/queued next chunk.
        const next = index + 1 < count ? chunk(index + 1) : Promise.resolve(undefined);
        const [, queued] = await this.pending(Promise.all([ended, next]), operation);
        this.check(operation);
        if (queued) pcm = queued;
      }
      this.clear(operation);
      this.generating = false;
      this.currentState = "stopping";
      // Retain only the idle model; release the playback graph before publishing readiness.
      if (!await this.closeAudio()) throw new Error("Audio teardown failed");
      this.check(operation);
      this.operation = undefined;
      this.currentState = "ready";
      this.publish("finished");
    } catch (error) { await this.fail(operation); throw error; }
  }

  private play(pcm: Float32Array, operation: Operation, context: AudioContext, gain: GainNode): Promise<void> {
    this.check(operation);
    if (context.state !== "running") throw new Error("Audio interrupted");
    const buffer = context.createBuffer(1, pcm.length, TTS_SAMPLE_RATE);
    buffer.copyToChannel(pcm as Float32Array<ArrayBuffer>, 0);
    const source = context.createBufferSource();
    this.sources.add(source);
    source.buffer = buffer;
    source.connect(gain);
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        operation.abort.signal.removeEventListener("abort", aborted);
        if (error !== undefined) reject(error); else resolve();
      };
      const aborted = () => finish(operation.abort.signal.reason);
      operation.abort.signal.addEventListener("abort", aborted, { once: true });
      source.onended = () => {
        if (this.operation !== operation) return;
        source.onended = null;
        try { source.disconnect(); source.buffer = null; this.sources.delete(source); finish(); }
        catch { this.dependencies.coordinator.latchUnsafe(); finish(new Error("Audio disconnect failed")); }
      };
      try {
        this.check(operation);
        if (context.state !== "running") throw new Error("Audio interrupted");
        source.start();
        this.played = true;
        this.currentState = "playing";
        this.publish("playing");
      } catch (error) { finish(error); }
    });
  }

  private async fail(operation: Operation): Promise<void> {
    if (operation.epoch !== this.epoch) return;
    const partial = this.played;
    await this.stop();
    if (this.epoch !== operation.epoch + 1 || this.disposed) return;
    this.currentState = "failed";
    this.publish(partial ? "partial-playback" : "failed");
  }

  /** Independent best-effort cleanup; any uncertainty permanently closes this document's audio gate. */
  private closeAudio(): Promise<boolean> {
    if (this.closing) return this.closing;
    const context = this.context;
    const gain = this.gain;
    const resume = this.resume;
    this.context = undefined; this.gain = undefined; this.resume = undefined;
    let safe = true;
    const attempt = (action: () => void) => { try { action(); } catch { safe = false; } };
    if (context) attempt(() => { context.onstatechange = null; });
    if (gain) {
      attempt(() => { gain.gain.value = 0; });
      attempt(() => gain.disconnect());
    }
    for (const source of this.sources) {
      attempt(() => { source.onended = null; });
      attempt(() => source.stop());
      attempt(() => source.disconnect());
      attempt(() => { source.buffer = null; });
    }
    this.sources.clear();
    let close: Promise<void> = Promise.resolve();
    if (context) { try { close = Promise.resolve(context.close()); } catch { safe = false; } }
    if (!safe) this.dependencies.coordinator.latchUnsafe();
    const closing = new Promise<boolean>(resolve => {
      let settled = false;
      const finish = (confirmed: boolean) => {
        if (settled) return;
        settled = true;
        this.dependencies.clearTimeout(timer);
        if (!confirmed || !safe) this.dependencies.coordinator.latchUnsafe();
        resolve(this.cancellationSafe);
      };
      const timer = this.dependencies.setTimeout(() => finish(false), TTS_TEARDOWN_MS);
      void Promise.allSettled([close, ...(resume ? [resume] : [])]).then(results => {
        finish(results[0].status === "fulfilled" && (!context || context.state === "closed"));
      });
    });
    this.closing = closing;
    void closing.then(() => { if (this.closing === closing) this.closing = undefined; });
    return closing;
  }

  stop(): Promise<boolean> {
    if (this.stopping) return this.stopping;
    ++this.epoch; // Fence callbacks before terminating CPU/audio or notifying observers.
    const operation = this.operation;
    this.operation = undefined;
    if (operation) { operation.abort.abort(new DOMException("Speech canceled", "AbortError")); this.clear(operation); }
    this.currentState = "stopping";
    this.generating = false;
    this.progress = undefined;
    let resolve!: (safe: boolean) => void;
    const stopping = this.stopping = new Promise<boolean>(yes => { resolve = yes; });
    const runtime = this.runtime;
    this.runtime = undefined;
    try { runtime?.terminate(); } catch { this.dependencies.coordinator.latchUnsafe(); }
    const audio = this.closeAudio();
    this.publish("stopping");
    void audio.then(() => {
      this.dependencies.coordinator.release(this.owner);
      this.stopping = undefined;
      this.currentState = this.disposed ? "disposed" : "unprepared";
      this.publish(this.disposed ? "disposed" : "stopped");
      resolve(this.cancellationSafe);
    });
    return stopping;
  }
  dispose(): Promise<boolean> {
    this.disposed = true;
    this.permission = false;
    return this.stop();
  }
}

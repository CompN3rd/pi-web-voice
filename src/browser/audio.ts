import { PauseEndpoint } from "./recognition-endpoint.js";
import { CaptureTeardownError, openPcmCapture, type OpenPcmCapture, type PcmCapture } from "./recognition-capture.js";
import { hasSpeechEnergy, MAX_PCM_SAMPLES, MAX_TRANSCRIPT_CHARACTERS, MAX_UTTERANCE_SECONDS } from "./recognition-pcm.js";
import { WorkerRecognitionRuntime, type RecognitionRuntime, type SpeechPreparation } from "./recognition-runtime.js";
import { pageSpeechCoordinator, SpeechCoordinator, type SpeechOwner } from "./speech-coordinator.js";

export type { SpeechPreparation } from "./speech-assets.js";

export interface LocalRecognitionCallbacks {
  status(message: string): void;
  transcript(text: string): void;
  /** Residency handoff only: preserve drafts/approvals, but show that recognition needs preparation. */
  unprepared?(): void;
}
export interface LocalRecognitionDependencies {
  createRuntime(): RecognitionRuntime;
  openCapture: OpenPcmCapture;
  coordinator?: SpeechCoordinator;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
}
export type LocalRecognitionState = "unprepared" | "preparing" | "ready" | "starting" | "recording" | "transcribing" | "disposed";

/** Foreground, English-only, memory-only recognition. Text is untrusted and confers no instruction authority.
 * prepare() checks cache by default; download/import requires explicit options, never a microphone.
 * cancel() stops tracks and terminates the worker (including prepare), so prepare() is required again.
 * Failed/canceled operations reject; callers must handle rejections. No automatic retries or remote fallback.
 */
export class LocalRecognizer {
  private dependencies: LocalRecognitionDependencies = { createRuntime: () => new WorkerRecognitionRuntime(), openCapture: openPcmCapture };
  private currentState: LocalRecognitionState = "unprepared";
  private epoch = 0;
  private abort = new AbortController();
  private runtime?: RecognitionRuntime;
  private capture?: PcmCapture;
  private pcm?: Float32Array;
  private length = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private opening?: Promise<PcmCapture>;
  private openingSettled?: Promise<void>;
  private captureTeardown?: Promise<void>;
  private settling?: Promise<void>;
  private canceling = false;
  private coordinator = pageSpeechCoordinator();
  private readonly owner: SpeechOwner;
  constructor(private readonly callbacks: LocalRecognitionCallbacks) {
    const recognizer = this;
    this.owner = {
      kind: "recognition",
      get phase() {
        if (recognizer.settling || recognizer.canceling) return "stopping";
        if (recognizer.currentState === "preparing") return "preparing";
        return ["starting", "recording", "transcribing"].includes(recognizer.currentState) ? "active" : "idle";
      },
      release: () => {
        this.cancel();
        try { this.callbacks.unprepared?.(); } catch { /* Observers cannot retain resources. */ }
        try { this.callbacks.status("Recognition unprepared · speech runtime handed off; prepare explicitly to record"); } catch { /* Observer only. */ }
        return this.settling ? this.settling.then(() => this.coordinator.safe) : this.coordinator.safe;
      },
    };
  }

  /** True only when start() may be called; busy and canceled states are not ready. */
  get ready(): boolean { return this.currentState === "ready" && this.coordinator.owns(this.owner); }
  get state(): LocalRecognitionState { return this.currentState; }

  /** Explicit test-only dependency injection; production never selects an alternate engine/network path. */
  static createForTest(callbacks: LocalRecognitionCallbacks, dependencies: LocalRecognitionDependencies): LocalRecognizer {
    const recognizer = new LocalRecognizer(callbacks);
    recognizer.dependencies = dependencies;
    recognizer.coordinator = dependencies.coordinator ?? new SpeechCoordinator();
    return recognizer;
  }
  private check(epoch: number): void {
    if (epoch !== this.epoch || this.currentState === "disposed") throw new DOMException("Local speech canceled", "AbortError");
    if (!this.coordinator.safe) throw new Error("Audio unsafe; reload this page");
  }
  private status(epoch: number, message: string): void { this.check(epoch); this.callbacks.status(message); this.check(epoch); }
  private async pending<T>(task: Promise<T>, epoch: number): Promise<T> {
    const signal = this.abort.signal;
    // A synchronous dependency/status callback can cancel before this race is installed.
    void task.catch(() => {});
    let aborted: (() => void) | undefined;
    try {
      this.check(epoch);
      return await Promise.race([task, new Promise<never>((_, reject) => {
        aborted = () => reject(new DOMException("Local speech canceled", "AbortError"));
        signal.addEventListener("abort", aborted, { once: true });
        if (signal.aborted) aborted();
      })]);
    } finally { if (aborted) signal.removeEventListener("abort", aborted); }
  }
  async prepare(options: SpeechPreparation = { source: "cache" }): Promise<void> {
    if (this.ready) return;
    if (this.currentState !== "unprepared" || this.settling || this.canceling) throw new Error("Local speech is busy or disposed");
    const epoch = this.epoch;
    this.currentState = "preparing";
    try {
      const acquisition = this.coordinator.acquire(this.owner);
      if (acquisition) await this.pending(acquisition, epoch);
      this.check(epoch);
      this.status(epoch, "Preparing local English speech pack; no microphone is open…");
      const runtime = this.dependencies.createRuntime();
      try { this.check(epoch); } catch (error) {
        try { runtime.terminate(); } catch { this.coordinator.latchUnsafe(); }
        throw error;
      }
      this.runtime = runtime;
      await this.pending(runtime.prepare(message => { if (epoch === this.epoch) this.callbacks.status(message); }, options), epoch);
      this.check(epoch);
      this.currentState = "ready";
      this.status(epoch, "Local speech ready · audio stays on this device");
    } catch (error) { if (epoch === this.epoch) this.cancel(); throw error; }
  }
  async start(options: { finishOnPause?: boolean } = {}): Promise<void> {
    if (!this.ready) throw new Error("Prepare local speech before opening the microphone");
    const epoch = this.epoch;
    this.currentState = "starting";
    const endpoint = options.finishOnPause ? new PauseEndpoint() : undefined;
    let pauseReached = false;
    this.pcm = new Float32Array(MAX_PCM_SAMPLES);
    this.length = 0;
    try {
      this.status(epoch, "Requesting microphone permission for local capture…");
      this.timer = setTimeout(() => {
        if (epoch !== this.epoch) return;
        this.cancel();
        this.callbacks.status("Microphone startup timed out; prepare explicitly to retry");
      }, 30_000);
      let resolveOpening!: (capture: PcmCapture) => void;
      let rejectOpening!: (error: unknown) => void;
      const opening = this.opening = new Promise<PcmCapture>((resolve, reject) => { resolveOpening = resolve; rejectOpening = reject; });
      // Reserve the pending microphone before a dependency can synchronously call back/cancel.
      const openingSettled = this.openingSettled = opening.then(capture => {
        if (epoch !== this.epoch) return this.stopOwnedCapture(capture);
        // Own the result before the pending() continuation: cancellation may run in between.
        this.capture = capture;
      }, error => { if (error instanceof CaptureTeardownError) this.coordinator.latchUnsafe(); });
      const clearOpening = () => {
        if (this.opening === opening) { this.opening = undefined; this.openingSettled = undefined; }
      };
      void openingSettled.then(clearOpening, () => { this.coordinator.latchUnsafe(); clearOpening(); });
      try { void this.dependencies.openCapture(this.abort.signal, chunk => {
        if (epoch !== this.epoch || !["starting", "recording"].includes(this.currentState) || !this.pcm) return;
        const count = Math.min(chunk.length, MAX_PCM_SAMPLES - this.length);
        this.pcm.set(chunk.subarray(0, count), this.length);
        this.length += count;
        pauseReached = pauseReached || (endpoint?.push(chunk.subarray(0, count)) ?? false);
        if ((this.length === MAX_PCM_SAMPLES || pauseReached) && this.currentState === "recording") this.finishAtLimit(epoch);
      }, error => {
        if (epoch !== this.epoch) return;
        this.cancel();
        this.callbacks.status(error.message);
      }).then(resolveOpening, rejectOpening); } catch (error) { rejectOpening(error); }
      const capture = await this.pending(opening, epoch);
      this.check(epoch);
      this.capture = capture;
      this.currentState = "recording";
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.finishAtLimit(epoch), MAX_UTTERANCE_SECONDS * 1000);
      this.status(epoch, "Listening locally · finish within 20 seconds");
      if (this.length === MAX_PCM_SAMPLES || pauseReached) this.finishAtLimit(epoch);
    } catch (error) { if (epoch === this.epoch) this.cancel(); throw error; }
  }
  private finishAtLimit(epoch: number): void {
    if (epoch !== this.epoch || this.currentState !== "recording") return;
    // finish reports active failures; cancellation must never produce a later status callback.
    void this.finish().catch(() => {});
  }
  async finish(): Promise<void> {
    if (this.currentState !== "recording") throw new Error("Local speech is not recording");
    const epoch = this.epoch;
    this.currentState = "transcribing";
    try {
      const stopped = this.stopCapture();
      if (stopped) await this.pending(stopped, epoch);
      this.check(epoch);
      const pcm = this.pcm!.slice(0, this.length);
      this.pcm = undefined;
      this.length = 0;
      if (!hasSpeechEnergy(pcm)) {
        this.currentState = "ready";
        this.status(epoch, "No speech detected; nothing submitted");
        return;
      }
      this.status(epoch, "Transcribing on this device · microphone off…");
      const result = await this.pending(this.runtime!.transcribe(pcm), epoch);
      this.check(epoch);
      const text = result.trim().slice(0, MAX_TRANSCRIPT_CHARACTERS);
      this.currentState = "ready";
      this.status(epoch, text ? "Local transcript ready for review" : "No transcript; nothing submitted");
      if (text) this.callbacks.transcript(text);
    } catch (error) {
      if (epoch === this.epoch) {
        this.cancel();
        this.callbacks.status("Local transcription failed; prepare explicitly to retry");
      }
      throw error;
    }
  }
  private boundedTeardown(task: Promise<void>): Promise<void> {
    const bounded = new Promise<void>((resolve, reject) => {
      const timer = (this.dependencies.setTimeout ?? setTimeout)(() => {
        this.coordinator.latchUnsafe(); reject(new CaptureTeardownError());
      }, 5_000);
      void task.then(() => { (this.dependencies.clearTimeout ?? clearTimeout)(timer); resolve(); }, () => {
        (this.dependencies.clearTimeout ?? clearTimeout)(timer);
        this.coordinator.latchUnsafe(); reject(new CaptureTeardownError());
      });
    });
    void bounded.catch(() => {});
    return bounded;
  }
  private stopOwnedCapture(capture: PcmCapture): void | Promise<void> {
    try {
      const stopped = capture.stop();
      if (!stopped) return;
      const teardown = this.captureTeardown = this.boundedTeardown(stopped);
      const clear = () => { if (this.captureTeardown === teardown) this.captureTeardown = undefined; };
      void teardown.then(clear, clear);
      return teardown;
    } catch (error) { this.coordinator.latchUnsafe(); throw error; }
  }
  private stopCapture(): void | Promise<void> {
    clearTimeout(this.timer); this.timer = undefined;
    const capture = this.capture; this.capture = undefined;
    if (capture) return this.stopOwnedCapture(capture);
  }
  cancel(): void {
    if (this.canceling) return;
    this.canceling = true;
    ++this.epoch;
    const abort = this.abort;
    this.abort = new AbortController();
    const runtime = this.runtime; this.runtime = undefined;
    if (this.currentState !== "disposed") this.currentState = "unprepared";
    try { abort.abort(); } catch { this.coordinator.latchUnsafe(); }
    try { this.stopCapture(); } catch { /* Latch set; still terminate independently. */ }
    this.pcm?.fill(0);
    this.pcm = undefined;
    this.length = 0;
    try { runtime?.terminate(); } catch { this.coordinator.latchUnsafe(); }
    const tasks = [this.openingSettled, this.captureTeardown].filter((task): task is Promise<void> => !!task);
    if (tasks.length && !this.settling) {
      // Keep the synchronous cancel API, but retain ownership until tracks AND graph are settled.
      const finish = () => { this.settling = undefined; this.coordinator.release(this.owner); };
      this.settling = this.boundedTeardown(Promise.all(tasks).then(() => {})).then(finish, finish);
    } else if (!this.settling) this.coordinator.release(this.owner);
    this.canceling = false;
  }
  dispose(): void { this.currentState = "disposed"; this.cancel(); }
}

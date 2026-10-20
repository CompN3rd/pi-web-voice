import { openPcmCapture, type OpenPcmCapture, type PcmCapture } from "./recognition-capture.js";
import { hasSpeechEnergy, MAX_PCM_SAMPLES, MAX_TRANSCRIPT_CHARACTERS, MAX_UTTERANCE_SECONDS } from "./recognition-pcm.js";
import { WorkerRecognitionRuntime, type RecognitionRuntime } from "./recognition-runtime.js";

export interface LocalRecognitionCallbacks {
  status(message: string): void;
  transcript(text: string): void;
}
export interface LocalRecognitionDependencies {
  createRuntime(): RecognitionRuntime;
  openCapture: OpenPcmCapture;
}
export type LocalRecognitionState = "unprepared" | "preparing" | "ready" | "starting" | "recording" | "transcribing" | "disposed";

/** Foreground, English-only, memory-only recognition. Text is untrusted and confers no instruction authority.
 * prepare() is explicit consent to fetch/check the self-hosted speech pack, without opening the microphone.
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
  constructor(private readonly callbacks: LocalRecognitionCallbacks) {}

  /** True only when start() may be called; busy and canceled states are not ready. */
  get ready(): boolean { return this.currentState === "ready"; }
  get state(): LocalRecognitionState { return this.currentState; }

  /** Explicit test-only dependency injection; production never selects an alternate engine/network path. */
  static createForTest(callbacks: LocalRecognitionCallbacks, dependencies: LocalRecognitionDependencies): LocalRecognizer {
    const recognizer = new LocalRecognizer(callbacks);
    recognizer.dependencies = dependencies;
    return recognizer;
  }
  private check(epoch: number): void {
    if (epoch !== this.epoch || this.currentState === "disposed") throw new DOMException("Local speech canceled", "AbortError");
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
  async prepare(): Promise<void> {
    if (this.ready) return;
    if (this.currentState !== "unprepared") throw new Error("Local speech is busy or disposed");
    const epoch = this.epoch;
    this.currentState = "preparing";
    try {
      this.status(epoch, "Preparing local English speech pack; no microphone is open…");
      const runtime = this.runtime = this.dependencies.createRuntime();
      await this.pending(runtime.prepare(message => { if (epoch === this.epoch) this.callbacks.status(message); }), epoch);
      this.check(epoch);
      this.currentState = "ready";
      this.status(epoch, "Local speech ready · audio stays on this device");
    } catch (error) { if (epoch === this.epoch) this.cancel(); throw error; }
  }
  async start(): Promise<void> {
    if (!this.ready) throw new Error("Prepare local speech before opening the microphone");
    const epoch = this.epoch;
    this.currentState = "starting";
    this.pcm = new Float32Array(MAX_PCM_SAMPLES);
    this.length = 0;
    try {
      this.status(epoch, "Requesting microphone permission for local capture…");
      this.timer = setTimeout(() => {
        if (epoch !== this.epoch) return;
        this.cancel();
        this.callbacks.status("Microphone startup timed out; prepare explicitly to retry");
      }, 30_000);
      const opening = this.dependencies.openCapture(this.abort.signal, chunk => {
        if (epoch !== this.epoch || !["starting", "recording"].includes(this.currentState) || !this.pcm) return;
        const count = Math.min(chunk.length, MAX_PCM_SAMPLES - this.length);
        this.pcm.set(chunk.subarray(0, count), this.length);
        this.length += count;
        if (this.length === MAX_PCM_SAMPLES && this.currentState === "recording") this.finishAtLimit(epoch);
      }, error => {
        if (epoch !== this.epoch) return;
        this.cancel();
        this.callbacks.status(error.message);
      });
      // Even non-cooperative test captures and late permission grants must release their tracks.
      void opening.then(capture => { if (epoch !== this.epoch) capture.stop(); }, () => {});
      const capture = await this.pending(opening, epoch);
      this.check(epoch);
      this.capture = capture;
      this.currentState = "recording";
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.finishAtLimit(epoch), MAX_UTTERANCE_SECONDS * 1000);
      this.status(epoch, "Listening locally · finish within 20 seconds");
      if (this.length === MAX_PCM_SAMPLES) this.finishAtLimit(epoch);
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
    this.stopCapture();
    const pcm = this.pcm!.slice(0, this.length);
    this.pcm = undefined;
    this.length = 0;
    try {
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
  private stopCapture(): void { clearTimeout(this.timer); this.timer = undefined; this.capture?.stop(); this.capture = undefined; }
  cancel(): void {
    ++this.epoch;
    this.abort.abort();
    this.abort = new AbortController();
    this.stopCapture();
    this.pcm?.fill(0);
    this.pcm = undefined;
    this.length = 0;
    this.runtime?.terminate();
    this.runtime = undefined;
    if (this.currentState !== "disposed") this.currentState = "unprepared";
  }
  dispose(): void { this.cancel(); this.currentState = "disposed"; }
}

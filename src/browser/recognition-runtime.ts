import type { SpeechPreparation } from "./recognition-assets.js";
export type { SpeechPreparation } from "./recognition-assets.js";

export interface RecognitionRuntime {
  prepare(status: (message: string) => void, options?: SpeechPreparation): Promise<void>;
  transcribe(pcm: Float32Array): Promise<string>;
  terminate(): void;
}

/** No transport/host access: this worker accepts only prepare and bounded PCM inference. */
export class WorkerRecognitionRuntime implements RecognitionRuntime {
  private worker = new Worker(new URL("./recognition-worker.js", import.meta.url), { type: "module", name: "local-speech" });
  private sequence = 0;
  private pending?: { id: number; resolve(value: string): void; reject(error: Error): void; status(message: string): void; timer: ReturnType<typeof setTimeout> };
  private closed = false;
  constructor() {
    this.worker.onmessage = ({ data }) => {
      const pending = this.pending;
      if (!pending || data?.id !== pending.id || this.closed) return;
      if (data.type === "status" && typeof data.message === "string") { pending.status(data.message.slice(0, 300)); return; }
      clearTimeout(pending.timer);
      this.pending = undefined;
      if (data.type === "ready") pending.resolve("");
      else if (data.type === "transcript" && typeof data.text === "string") pending.resolve(data.text);
      else pending.reject(new Error(typeof data.message === "string" ? data.message.slice(0, 500) : "Local speech worker failed"));
    };
    this.worker.onerror = event => { event.preventDefault(); this.terminate(); };
    this.worker.onmessageerror = () => this.terminate();
  }
  async prepare(status: (message: string) => void, options: SpeechPreparation = { source: "cache" }): Promise<void> { await this.request("prepare", status, undefined, options); }
  transcribe(pcm: Float32Array): Promise<string> { return this.request("transcribe", () => {}, pcm); }
  private request(type: string, status: (message: string) => void, pcm?: Float32Array, options?: SpeechPreparation): Promise<string> {
    if (this.closed || this.pending) return Promise.reject(new Error("Local speech worker unavailable or busy"));
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => this.terminate(), type === "prepare" ? 300_000 : 120_000);
      this.pending = { id, resolve, reject, status, timer };
      try { this.worker.postMessage({ id, type, pcm, options }, pcm ? [pcm.buffer as ArrayBuffer] : []); }
      catch (error) { this.terminate(); }
    });
  }
  terminate(): void {
    if (this.closed) return;
    this.closed = true;
    this.worker.onmessage = null;
    this.worker.onerror = null;
    this.worker.onmessageerror = null;
    this.worker.terminate();
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(new Error("Local speech worker stopped or timed out; prepare explicitly to retry"));
      this.pending = undefined;
    }
  }
}

import type { SpeechPreparation } from "./speech-assets.js";
import { TTS_PROTOCOL, TTS_SAMPLE_RATE, TTS_MAX_TEXT, TTS_MAX_CHUNKS, TTS_MAX_TOTAL_SAMPLES, TTS_PREPARE_MS, TTS_INITIALIZE_MS, TTS_INACTIVITY_MS, TTS_JOB_MS, validTtsPcm, type TtsProgress, type TtsRuntime } from "./tts-contract.js";

declare const __TTS_CACHE__: string;
declare const __TTS_BUILD__: string;
export type TtsErrorCode = "stopped" | "busy" | "not-ready" | "protocol" | "reload-required" | "timeout" | "worker" | "prepare" | "text" | "synthesis";
export const TTS_ERROR_CODES: readonly TtsErrorCode[] = ["stopped", "busy", "not-ready", "protocol", "reload-required", "timeout", "worker", "prepare", "text", "synthesis"];
export interface TtsFence { version: number; pack: string; build: string; instance: string; id: number; }
export interface TtsWorkerPort {
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent) => void) | null;
  postMessage(value: unknown): void;
  terminate(): void;
}
export interface TtsRuntimeOptions {
  worker?: () => TtsWorkerPort;
  pack?: string;
  build?: string;
  deadlines?: { prepare?: number; initialize?: number; inactivity?: number; job?: number };
}
type Operation = "prepare" | "plan" | "chunk";
interface Pending {
  id: number; type: Operation; resolve(value: unknown): void; reject(error: Error): void;
  status: (progress: TtsProgress) => void; timer: ReturnType<typeof setTimeout>;
  initTimer?: ReturnType<typeof setTimeout>; initializing: boolean; checked: number;
}
let instances = 0;
const failure = (code: TtsErrorCode) => new Error(`TTS ${code}; explicitly prepare again${code === "reload-required" ? " after page reload" : ""}`);

/** Inert until explicit prepare; a failed/stopped instance is never silently restarted. */
export class WorkerTtsRuntime implements TtsRuntime {
  private worker?: TtsWorkerPort;
  private pending?: Pending;
  private sequence = 0;
  private readonly instance = `tts-${++instances}`;
  private closed = false;
  private ready = false;
  private count = 0;
  private next = 0;
  private samples = 0;
  private jobTimer?: ReturnType<typeof setTimeout>;
  private readonly pack: string;
  private readonly build: string;
  constructor(private readonly options: TtsRuntimeOptions = {}) {
    this.pack = options.pack ?? (typeof __TTS_CACHE__ === "undefined" ? "" : __TTS_CACHE__);
    this.build = options.build ?? (typeof __TTS_BUILD__ === "undefined" ? "" : __TTS_BUILD__);
  }
  async prepare(status: (progress: TtsProgress) => void, options: SpeechPreparation = { source: "cache" }): Promise<void> {
    if (this.closed) throw failure("stopped");
    if (this.pending || this.ready) throw failure("busy");
    if (!this.pack || !this.build || this.pack.length > 160 || this.build.length > 160) { this.stop("reload-required"); throw failure("reload-required"); }
    if (!options || !["cache", "download", "import"].includes(options.source) || (options.source === "import" && !(options.file instanceof Blob))) throw failure("prepare");
    try {
      this.worker = this.options.worker ? this.options.worker() : new Worker(new URL("./tts-bootstrap.js", import.meta.url), { type: "module", name: "local-tts" });
      this.worker.onmessage = ({ data }) => this.receive(data);
      this.worker.onerror = event => { event.preventDefault(); this.stop("worker"); };
      this.worker.onmessageerror = () => this.stop("worker");
    } catch { this.stop("worker"); throw failure("worker"); }
    await this.request("prepare", { options }, status);
  }
  async plan(text: string): Promise<number> {
    if (this.pending || this.count) throw failure("busy");
    if (!this.ready || this.closed) throw failure("not-ready");
    if (typeof text !== "string" || !text.trim() || text.length > TTS_MAX_TEXT) throw failure("text");
    this.samples = 0;
    this.next = 0;
    this.jobTimer = setTimeout(() => this.stop("timeout"), this.options.deadlines?.job ?? TTS_JOB_MS);
    return await this.request("plan", { text }) as number;
  }
  async chunk(index: number): Promise<Float32Array> {
    if (this.pending) throw failure("busy");
    if (!this.ready || this.closed) throw failure("not-ready");
    if (!Number.isSafeInteger(index) || !this.count || index !== this.next || index >= this.count) { this.stop("protocol"); throw failure("protocol"); }
    return await this.request("chunk", { index }) as Float32Array;
  }
  private request(type: Operation, payload: object, status: (progress: TtsProgress) => void = () => {}): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => this.stop("timeout"), type === "prepare" ? this.options.deadlines?.prepare ?? TTS_PREPARE_MS : this.options.deadlines?.inactivity ?? TTS_INACTIVITY_MS);
      this.pending = { id, type, resolve, reject, status, timer, initializing: false, checked: 0 };
      try { this.worker!.postMessage({ version: TTS_PROTOCOL, pack: this.pack, build: this.build, instance: this.instance, id, type, ...payload }); }
      catch { this.stop("worker"); }
    });
  }
  private receive(data: unknown): void {
    const p = this.pending;
    if (this.closed || !p || !data || typeof data !== "object") return;
    const d = data as Record<string, unknown>;
    if (d.id !== p.id || (typeof d.instance === "string" && d.instance !== this.instance)) return;
    if (d.instance !== this.instance) return this.stop("protocol");
    if (d.version !== TTS_PROTOCOL || d.pack !== this.pack || d.build !== this.build) return this.stop("reload-required");
    if (d.type === "error") return this.stop(TTS_ERROR_CODES.includes(d.code as TtsErrorCode) ? d.code as TtsErrorCode : "protocol");
    if (d.type === "progress" && p.type === "prepare") {
      const progress = d.progress as Partial<TtsProgress> | undefined;
      if (!progress || (progress.phase !== "checking" && progress.phase !== "initializing")) return this.stop("protocol");
      if (progress.phase === "checking") {
        if (p.initializing || !Number.isSafeInteger(progress.checkedBytes) || !Number.isSafeInteger(progress.totalBytes)
          || progress.checkedBytes! < p.checked || progress.checkedBytes! < 0 || progress.totalBytes! > 128_000_000 || progress.totalBytes! <= 0 || progress.checkedBytes! > progress.totalBytes!) return this.stop("protocol");
        p.checked = progress.checkedBytes!;
      } else if (!p.initializing) {
        p.initializing = true;
        p.initTimer = setTimeout(() => this.stop("timeout"), this.options.deadlines?.initialize ?? TTS_INITIALIZE_MS);
      }
      try { p.status(progress.phase === "checking" ? { phase: "checking", checkedBytes: progress.checkedBytes, totalBytes: progress.totalBytes } : { phase: "initializing" }); }
      catch { this.stop("worker"); }
      return;
    }
    let result: unknown;
    if (p.type === "prepare" && d.type === "ready" && p.initializing) this.ready = true;
    else if (p.type === "plan" && d.type === "planned" && Number.isSafeInteger(d.chunkCount) && (d.chunkCount as number) > 0 && (d.chunkCount as number) <= TTS_MAX_CHUNKS) result = this.count = d.chunkCount as number;
    else if (p.type === "chunk" && d.type === "chunk" && d.index === this.next && d.sampleRate === TTS_SAMPLE_RATE && validTtsPcm(d.pcm)
      && d.pcm.byteOffset === 0 && d.pcm.byteLength === d.pcm.buffer.byteLength && d.pcm.buffer instanceof ArrayBuffer && this.samples + d.pcm.length <= TTS_MAX_TOTAL_SAMPLES) {
      result = d.pcm;
      this.samples += d.pcm.length;
      if (++this.next === this.count) { this.count = 0; clearTimeout(this.jobTimer); this.jobTimer = undefined; }
    } else return this.stop("protocol");
    clearTimeout(p.timer); clearTimeout(p.initTimer);
    this.pending = undefined;
    p.resolve(result);
  }
  terminate(): void { this.stop("stopped"); }
  private stop(code: TtsErrorCode): void {
    if (this.closed) return;
    this.closed = true; this.ready = false; this.count = 0;
    const p = this.pending; this.pending = undefined;
    clearTimeout(this.jobTimer); this.jobTimer = undefined;
    if (p) { clearTimeout(p.timer); clearTimeout(p.initTimer); p.reject(failure(code)); }
    const worker = this.worker; this.worker = undefined;
    if (worker) {
      worker.onmessage = null; worker.onerror = null; worker.onmessageerror = null;
      try { worker.terminate(); } catch { /* Pending callers have already settled and callbacks are fenced. */ }
    }
  }
}

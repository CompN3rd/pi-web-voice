import { loadTtsAssets, type TtsLoader } from "./tts-loader.js";
import type { SpeechAsset, SpeechPreparation } from "./speech-assets.js";
import { TTS_PROTOCOL, TTS_SAMPLE_RATE, TTS_MAX_CHUNKS, TTS_MAX_TEXT, TTS_MAX_TOTAL_SAMPLES, TTS_PREPARE_MS, TTS_INITIALIZE_MS, TTS_INACTIVITY_MS, TTS_JOB_MS, validTtsPcm } from "./tts-contract.js";
import type { TtsErrorCode, TtsFence } from "./tts-runtime.js";
import type { TtsModelAdapter } from "./tts-adapter.js";

declare const __TTS_ASSETS__: SpeechAsset[];
declare const __TTS_CACHE__: string;
declare const __TTS_BUILD__: string;

export function startTtsWorker(download: typeof fetch, installFetch: (fetcher: typeof fetch) => void): void {
  const scope = globalThis as unknown as { onmessage: ((event: MessageEvent) => void) | null; postMessage(message: unknown, transfer?: Transferable[]): void; close(): void };
  let instance: string | undefined;
  let sequence = 0;
  let busy = false;
  let closed = false;
  let adapter: TtsModelAdapter | undefined;
  let loader: TtsLoader | undefined;
  let count = 0;
  let next = 0;
  let samples = 0;
  let jobTimer: ReturnType<typeof setTimeout> | undefined;
  const send = (fence: TtsFence, value: object, transfer: Transferable[] = []) => {
    if (!closed) scope.postMessage({ ...fence, ...value }, transfer);
  };
  const fail = (fence: TtsFence, code: TtsErrorCode) => {
    if (closed) return;
    try { send(fence, { type: "error", code }); }
    finally { closed = true; clearTimeout(jobTimer); loader?.dispose(); scope.onmessage = null; scope.close(); }
  };
  scope.onmessage = ({ data }) => {
    if (closed || !data || typeof data !== "object" || !Number.isSafeInteger(data.id) || data.id <= 0 || typeof data.instance !== "string" || !data.instance || data.instance.length > 160) return;
    const fence: TtsFence = { id: data.id, instance: data.instance, version: TTS_PROTOCOL, pack: __TTS_CACHE__, build: __TTS_BUILD__ };
    if (instance && data.instance !== instance) return;
    if (data.id <= sequence) return;
    if (data.version !== TTS_PROTOCOL || data.pack !== __TTS_CACHE__ || data.build !== __TTS_BUILD__) return fail(fence, "reload-required");
    if (busy) return fail(fence, "busy");
    instance = data.instance; sequence = data.id; busy = true;
    const preparing = data.type === "prepare";
    const timer = setTimeout(() => fail(fence, "timeout"), preparing ? TTS_PREPARE_MS : TTS_INACTIVITY_MS);
    let initTimer: ReturnType<typeof setTimeout> | undefined;
    void (async () => {
      try {
        if (preparing && !adapter) {
          const options = data.options as SpeechPreparation;
          if (!options || !["cache", "import", "download"].includes(options.source)) return fail(fence, "prepare");
          loader = await loadTtsAssets(new URL("./tts-cache/", import.meta.url), __TTS_ASSETS__, __TTS_CACHE__, download, installFetch, options, progress => {
            if (progress.phase === "initializing" && !initTimer) initTimer = setTimeout(() => fail(fence, "timeout"), TTS_INITIALIZE_MS);
            send(fence, { type: "progress", progress });
          });
          if (closed) { loader.dispose(); return; }
          // Imports the one pinned Transformers instance only behind bootstrap.
          const { TtsModelAdapter } = await import("./tts-adapter.js");
          if (closed) return;
          adapter = await TtsModelAdapter.create(loader);
          if (!closed) send(fence, { type: "ready" });
        } else if (data.type === "plan" && adapter && !count) {
          if (typeof data.text !== "string" || !data.text.trim() || data.text.length > TTS_MAX_TEXT) return fail(fence, "text");
          jobTimer = setTimeout(() => fail(fence, "timeout"), TTS_JOB_MS);
          count = await adapter.plan(data.text);
          if (!Number.isSafeInteger(count) || count < 1 || count > TTS_MAX_CHUNKS) return fail(fence, "text");
          next = 0; samples = 0;
          send(fence, { type: "planned", chunkCount: count });
        } else if (data.type === "chunk" && adapter && count) {
          if (!Number.isSafeInteger(data.index) || data.index !== next || next >= count) return fail(fence, "protocol");
          const pcm = await adapter.chunk(next);
          if (!validTtsPcm(pcm) || pcm.byteOffset !== 0 || pcm.byteLength !== pcm.buffer.byteLength || !(pcm.buffer instanceof ArrayBuffer) || samples + pcm.length > TTS_MAX_TOTAL_SAMPLES) return fail(fence, "synthesis");
          samples += pcm.length;
          send(fence, { type: "chunk", index: next++, sampleRate: TTS_SAMPLE_RATE, pcm }, [pcm.buffer]);
          if (next === count) { count = 0; clearTimeout(jobTimer); jobTimer = undefined; }
        } else fail(fence, "protocol");
      } catch { fail(fence, preparing ? "prepare" : data.type === "plan" ? "text" : "synthesis"); }
      finally { clearTimeout(timer); clearTimeout(initTimer); busy = false; }
    })();
  };
}

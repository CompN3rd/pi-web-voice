import { env, pipeline, type AutomaticSpeechRecognitionPipeline } from "@huggingface/transformers";
import { cacheOnlySpeechFetch, prepareSpeechAssets, speechAssetUrls, type SpeechAsset, type SpeechPreparation } from "./speech-assets.js";
import { hasSpeechEnergy, MAX_TRANSCRIPT_CHARACTERS } from "./recognition-pcm.js";

// Build injects pinned model checksums plus hashes of the matching npm runtime assets.
declare const __SPEECH_ASSETS__: SpeechAsset[];
declare const __SPEECH_CACHE__: string;
const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage(value: unknown): void;
};
const base = new URL("./speech-cache/", import.meta.url);
const urls = speechAssetUrls(base, __SPEECH_ASSETS__);
const download = globalThis.fetch.bind(globalThis);
// ORT's pinned glue falls back to synchronous XHR when fetch fails. It must not
// bypass cache-only fetch or integrity verification, even after cache eviction.
Object.defineProperty(globalThis, "XMLHttpRequest", { value: class {
  constructor() { throw new Error("XMLHttpRequest is disabled in the local speech worker"); }
}, writable: false, configurable: false });
// Deny fetch even before preparation; only prepareSpeechAssets receives the original downloader.
globalThis.fetch = async () => { throw new Error("Local speech assets have not been prepared"); };
let recognizer: AutomaticSpeechRecognitionPipeline | undefined;
let busy = false;
let prepared = false;

async function prepare(id: number, options?: SpeechPreparation): Promise<void> {
  const cache = await caches.open(__SPEECH_CACHE__);
  await prepareSpeechAssets(urls, cache, download, message => scope.postMessage({ id, type: "status", message }), options);
  const localFetch = cacheOnlySpeechFetch(urls, cache);
  globalThis.fetch = localFetch;
  env.allowLocalModels = true;
  env.allowRemoteModels = false;
  env.localModelPath = new URL("models/", base).href;
  env.useBrowserCache = false;
  env.useFSCache = false;
  env.useFS = false;
  env.useCustomCache = false;
  const wasm = env.backends.onnx.wasm!;
  wasm.numThreads = 1;
  wasm.proxy = false;
  wasm.initTimeout = 60_000;
  // Dynamic runtime import uses verified cached bytes, not a CDN or an implicit HTTP request.
  const moduleBytes = await (await localFetch(new URL("ort/ort-wasm-simd-threaded.jsep.mjs", base))).arrayBuffer();
  const moduleUrl = URL.createObjectURL(new Blob([moduleBytes], { type: "text/javascript" }));
  // ORT 1.22's glue resolves a WASM URL even when given wasmBinary. Supplying the
  // explicit URL avoids resolving relative to blob:; fetch is already cache-only.
  wasm.wasmPaths = { mjs: moduleUrl, wasm: new URL("ort/ort-wasm-simd-threaded.jsep.wasm", base).href };
  try {
    // Narrow the public generic factory: its full model union exceeds TypeScript's representation limit.
    const createWhisper = pipeline as (task: "automatic-speech-recognition", model: string, options: { device: "wasm"; dtype: "q8"; local_files_only: true }) => Promise<AutomaticSpeechRecognitionPipeline>;
    recognizer = await createWhisper("automatic-speech-recognition", "onnx-community/whisper-tiny.en", {
      device: "wasm", dtype: "q8", local_files_only: true,
    });
  } finally { URL.revokeObjectURL(moduleUrl); }
  prepared = true;
}

scope.onmessage = ({ data }) => {
  if (!Number.isSafeInteger(data?.id) || busy) return;
  const id: number = data.id;
  busy = true;
  void (async () => {
    try {
      if (data.type === "prepare" && !prepared) {
        await prepare(id, data.options);
        scope.postMessage({ id, type: "ready" });
      } else if (data.type === "transcribe" && prepared && recognizer) {
        const pcm = data.pcm;
        if (!(pcm instanceof Float32Array) || !hasSpeechEnergy(pcm)) throw new Error("Invalid or silent speech input");
        try {
          const result = await recognizer(pcm, { max_new_tokens: 128, return_timestamps: false, do_sample: false });
          if (Array.isArray(result)) throw new Error("Unexpected batched speech result");
          scope.postMessage({ id, type: "transcript", text: result.text.trim().slice(0, MAX_TRANSCRIPT_CHARACTERS) });
        } finally { pcm.fill(0); }
      } else throw new Error("Local speech worker not ready");
    } catch (error) {
      scope.postMessage({ id, type: "error", message: error instanceof Error ? error.message : "Local speech failed" });
    } finally { busy = false; }
  })();
};

import { cacheOnlySpeechFetch, prepareSpeechAssets, speechAssetUrls, type SpeechAsset, type SpeechPreparation } from "./speech-assets.js";
import type { TtsProgress } from "./tts-contract.js";
import { TTS_IMPORT_ONLY_REASON } from "./speech-pack-kind.js";
import type { EnglishPhonemizer } from "./tts-text.js";

export interface TtsLoader {
  base: URL;
  fetch: typeof fetch;
  phonemize: EnglishPhonemizer;
  ortModuleUrl: string;
  dispose(): void;
}

/** The source-built module embeds WASM/data and needs no gzip streams. */
export function assertTtsLoaderCapabilities(): void {
  if (typeof Blob !== "function" || typeof URL.createObjectURL !== "function"
    || typeof WebAssembly !== "object") throw new Error("TTS prepare");
}

/** Only verified cache bytes become executable blob modules. Call exclusively
 * after bootstrap's transport guards, before importing the model dependency.
 */
export async function loadTtsAssets(base: URL, assets: SpeechAsset[], cacheName: string, download: typeof fetch,
  installFetch: (fetcher: typeof fetch) => void, options: SpeechPreparation, progress: (value: TtsProgress) => void): Promise<TtsLoader> {
  if (options.source === "download") throw new Error(TTS_IMPORT_ONLY_REASON);
  assertTtsLoaderCapabilities();
  const urls = speechAssetUrls(base, assets, "tts");
  const totalBytes = assets.reduce((sum, asset) => sum + asset.bytes, 0);
  const cache = await caches.open(cacheName);
  progress({ phase: "checking", checkedBytes: 0, totalBytes });
  await prepareSpeechAssets(urls, cache, download, message => {
    const match = /^Local speech pack checked (\d+) \/ (\d+) bytes$/.exec(message);
    if (match) progress({ phase: "checking", checkedBytes: Number(match[1]), totalBytes });
  }, options);
  const localFetch = cacheOnlySpeechFetch(urls, cache);
  installFetch(localFetch);
  progress({ phase: "initializing" });
  const blobs: string[] = [];
  const dispose = () => { for (const url of blobs) URL.revokeObjectURL(url); blobs.length = 0; };
  try {
    const moduleUrl = async (path: string) => {
      const bytes = await (await localFetch(new URL(path, base))).arrayBuffer();
      const url = URL.createObjectURL(new Blob([bytes], { type: "text/javascript" }));
      blobs.push(url);
      return url;
    };
    const phonemizerUrl = await moduleUrl("phonemizer/phonemizer.js");
    const module: { phonemize?: EnglishPhonemizer } = await import(/* @vite-ignore */ phonemizerUrl);
    if (typeof module.phonemize !== "function") throw new Error("TTS prepare");
    const ortModuleUrl = await moduleUrl("ort/ort-wasm-simd-threaded.jsep.mjs");
    return { base, fetch: localFetch, phonemize: module.phonemize, ortModuleUrl, dispose };
  } catch (error) { dispose(); throw error; }
}

import { TTS_IMPORT_ONLY_REASON, SPEECH_PACKS, speechPackKind, type SpeechPackKind } from "./speech-pack-kind.js";

export type SpeechPreparation = { source: "cache" } | { source: "download" } | { source: "import"; file: Blob };
export interface SpeechAsset { path: string; bytes: number; sha256: string; downloadUrl?: string; }

const models = {
  recognition: { prefix: "models/onnx-community/whisper-tiny.en/", distribution: "https://huggingface.co/onnx-community/whisper-tiny.en/resolve/2575352d61be1bf7225cf8f8b268a4678025fc58/" },
  tts: { prefix: "models/onnx-community/Kokoro-82M-v1.0-ONNX/", distribution: "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/1939ad2a8e416c0acfeecc08a694d14ef25f2231/" },
};
export type SpeechAssetUrls = ReadonlyMap<string, SpeechAsset> & { readonly kind: SpeechPackKind };
const runtimeDistribution = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0-dev.20250409-89f8206ba4/dist/";
const modelDownloadHosts = new Set(["huggingface.co", "cdn-lfs.huggingface.co", "cdn-lfs.hf.co", "cdn-lfs-us-1.hf.co", "cas-bridge.xethub.hf.co", "us.aws.cdn.hf.co"]);

function distributionUrl(asset: SpeechAsset, kind: SpeechPackKind): string {
  const model = models[kind];
  const expected = asset.path.startsWith(model.prefix) ? model.distribution + asset.path.slice(model.prefix.length)
    : asset.path.startsWith("ort/") ? runtimeDistribution + asset.path.slice(4)
    : undefined;
  if (!expected || asset.downloadUrl !== expected) throw new Error("Speech download URL is not a fixed distribution URL");
  return expected;
}

function checkDownloadResponse(response: Response, asset: SpeechAsset): void {
  // Fetch exposes the final URL, not every redirect hop. Integrity is checked separately.
  const final = new URL(response.url);
  const knownHost = asset.path.startsWith("ort/") || asset.path.startsWith("phonemizer/") ? final.hostname === "cdn.jsdelivr.net"
    : modelDownloadHosts.has(final.hostname) || /^[a-z0-9-]+(?:\.[a-z0-9-]+)?\.cdn\.hf\.co$/.test(final.hostname);
  if (final.protocol !== "https:" || final.username || final.password || final.port || !knownHost) {
    throw new Error("Speech download final URL is not a known HTTPS distribution");
  }
}
export interface SpeechAssetCache {
  match(url: string): Promise<Response | undefined>;
  put(url: string, response: Response): Promise<void>;
}

export function speechAssetUrls(base: URL, assets: readonly SpeechAsset[], kind: SpeechPackKind = "recognition"): SpeechAssetUrls {
  const limits = SPEECH_PACKS[speechPackKind(kind)];
  if (!["https:", "http:"].includes(base.protocol) || !base.pathname.endsWith("/")) throw new Error("Invalid speech asset base");
  const urls = new Map<string, SpeechAsset>();
  let total = 0;
  for (const asset of assets) {
    const allowedPath = kind === "recognition" ? /^(models|ort)\/[a-zA-Z0-9_./-]+$/.test(asset.path)
      : /^(models\/onnx-community\/Kokoro-82M-v1\.0-ONNX\/(config\.json|tokenizer\.json|tokenizer_config\.json|onnx\/model_quantized\.onnx|voices\/af_heart\.bin)|ort\/ort-wasm-simd-threaded\.jsep\.(mjs|wasm)|phonemizer\/phonemizer\.js)$/.test(asset.path);
    if (!allowedPath || asset.path.split("/").some(part => !part || part === "." || part === "..") ||
        !Number.isSafeInteger(asset.bytes) || asset.bytes <= 0 || asset.bytes > limits.maxFileBytes || !/^[a-f0-9]{64}$/.test(asset.sha256)) throw new Error("Invalid speech asset manifest");
    const url = new URL(asset.path, base);
    if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname) || urls.has(url.href)) throw new Error("Speech asset outside allowlist");
    total += asset.bytes;
    urls.set(url.href, asset);
  }
  if (!urls.size || urls.size > limits.maxFiles || total > limits.maxTotalBytes) throw new Error("Speech pack exceeds allowed bounds");
  return Object.defineProperty(Object.assign(urls, { kind }), "kind", { writable: false, configurable: false });
}

export async function verifiedAsset(response: Response, asset: SpeechAsset): Promise<ArrayBuffer> {
  if (!response.ok || !response.body) throw new Error(`Speech asset unavailable: ${asset.path}`);
  const reader = response.body.getReader();
  const bytes = new Uint8Array(asset.bytes);
  let offset = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (offset + value.byteLength > asset.bytes) throw new Error(`Speech asset too large: ${asset.path}`);
      bytes.set(value, offset);
      offset += value.byteLength;
    }
  } finally { await reader.cancel(); }
  if (offset !== asset.bytes) throw new Error(`Speech asset incomplete: ${asset.path}`);
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), byte => byte.toString(16).padStart(2, "0")).join("");
  if (digest !== asset.sha256) throw new Error(`Speech asset integrity failed: ${asset.path}`);
  return bytes.buffer;
}

/** Cache is the default; only explicit download can fetch. Import reads bounded slices in
 * manifest order. Partial verified entries are reusable, but readiness requires every file.
 */
export async function prepareSpeechAssets(urls: SpeechAssetUrls, cache: SpeechAssetCache, download: typeof fetch, status: (message: string) => void, options: SpeechPreparation = { source: "cache" }): Promise<void> {
  if (!options || !["cache", "download", "import"].includes(options.source)) throw new Error("Invalid speech preparation source");
  let checked = 0;
  const total = [...urls.values()].reduce((sum, asset) => sum + asset.bytes, 0);
  const magic = SPEECH_PACKS[speechPackKind(urls.kind)].magic;
  if (options.source === "download" && urls.kind === "tts") throw new Error(TTS_IMPORT_ONLY_REASON);
  if (options.source === "download") for (const asset of urls.values()) distributionUrl(asset, urls.kind);
  if (options.source === "import") {
    if (!(options.file instanceof Blob) || options.file.size !== total + 8) throw new Error("Speech import has incorrect total size");
    const header = new Uint8Array(await options.file.slice(0, 8).arrayBuffer());
    if (!header.every((byte, index) => byte === magic.charCodeAt(index))) throw new Error("Invalid speech import header");
  }
  for (const [url, asset] of urls) {
    if (options.source === "import") {
      const slice = options.file.slice(8 + checked, 8 + checked + asset.bytes);
      await cache.put(url, new Response(await verifiedAsset(new Response(slice), asset)));
    } else {
      const cached = await cache.match(url);
      let bytes: ArrayBuffer | undefined;
      if (cached) {
        try { bytes = await verifiedAsset(cached, asset); }
        catch (error) {
          if (options.source !== "download") throw error;
          status(`Replacing invalid cached speech asset: ${asset.path}`);
        }
      }
      if (!bytes) {
        if (options.source !== "download") throw new Error("Speech pack missing; explicitly download or import to prepare");
        // This explicit action permits one replacement, not a retry loop. Do not
        // overwrite even a corrupt cache entry until its replacement verifies.
        const response = await download(distributionUrl(asset, urls.kind), { method: "GET", credentials: "omit", referrerPolicy: "no-referrer", redirect: "follow", cache: "no-store" });
        checkDownloadResponse(response, asset);
        bytes = await verifiedAsset(response, asset);
        await cache.put(url, new Response(bytes));
      }
    }
    checked += asset.bytes;
    status(`Local speech pack checked ${checked} / ${total} bytes`);
  }
}

/** A cache miss is an error, never a fetch. Reject bodies, credentials, queries and off-list URLs. */
export function cacheOnlySpeechFetch(urls: ReadonlyMap<string, SpeechAsset>, cache: SpeechAssetCache): typeof fetch {
  return async (input, init) => {
    const request = input instanceof Request ? input : undefined;
    const url = request?.url ?? String(input);
    if ((init?.method ?? request?.method ?? "GET").toUpperCase() !== "GET" || init?.body != null || request?.body || init?.headers || request?.headers.has("authorization") || (init?.credentials ?? request?.credentials) === "include") throw new Error("Speech runtime only permits asset GETs");
    const asset = urls.get(url);
    if (!asset) throw new Error("Speech runtime asset URL is not allowlisted");
    const response = await cache.match(url);
    if (!response) throw new Error("Speech pack evicted; prepare explicitly to restore");
    return new Response(await verifiedAsset(response, asset), { headers: { "Content-Type": asset.path.endsWith(".wasm") ? "application/wasm" : "application/octet-stream" } });
  };
}

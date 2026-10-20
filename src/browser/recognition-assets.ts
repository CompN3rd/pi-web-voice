export type SpeechPreparation = { source: "cache" } | { source: "download" } | { source: "import"; file: Blob };
export interface SpeechAsset { path: string; bytes: number; sha256: string; downloadUrl?: string; }

const modelDistribution = "https://huggingface.co/onnx-community/whisper-tiny.en/resolve/2575352d61be1bf7225cf8f8b268a4678025fc58/";
const runtimeDistribution = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0-dev.20250409-89f8206ba4/dist/";
const modelDownloadHosts = new Set(["huggingface.co", "cdn-lfs.huggingface.co", "cdn-lfs.hf.co", "cdn-lfs-us-1.hf.co", "cas-bridge.xethub.hf.co", "us.aws.cdn.hf.co"]);

function distributionUrl(asset: SpeechAsset): string {
  const modelPrefix = "models/onnx-community/whisper-tiny.en/";
  const expected = asset.path.startsWith(modelPrefix) ? modelDistribution + asset.path.slice(modelPrefix.length)
    : asset.path.startsWith("ort/") ? runtimeDistribution + asset.path.slice(4) : undefined;
  if (!expected || asset.downloadUrl !== expected) throw new Error("Speech download URL is not a fixed distribution URL");
  return expected;
}

function checkDownloadResponse(response: Response, asset: SpeechAsset): void {
  // Fetch exposes the final URL, not every redirect hop. Integrity is checked separately.
  const final = new URL(response.url);
  const knownHost = asset.path.startsWith("ort/") ? final.hostname === "cdn.jsdelivr.net"
    : modelDownloadHosts.has(final.hostname) || /^[a-z0-9-]+(?:\.[a-z0-9-]+)?\.cdn\.hf\.co$/.test(final.hostname);
  if (final.protocol !== "https:" || final.username || final.password || final.port || !knownHost) {
    throw new Error("Speech download final URL is not a known HTTPS distribution");
  }
}
export interface SpeechAssetCache {
  match(url: string): Promise<Response | undefined>;
  put(url: string, response: Response): Promise<void>;
}

export function speechAssetUrls(base: URL, assets: readonly SpeechAsset[]): Map<string, SpeechAsset> {
  if (!["https:", "http:"].includes(base.protocol) || !base.pathname.endsWith("/")) throw new Error("Invalid speech asset base");
  const urls = new Map<string, SpeechAsset>();
  let total = 0;
  for (const asset of assets) {
    if (!/^(models|ort)\/[a-zA-Z0-9_./-]+$/.test(asset.path) || asset.path.split("/").some(part => !part || part === "." || part === "..") ||
        !Number.isSafeInteger(asset.bytes) || asset.bytes <= 0 || asset.bytes > 64_000_000 || !/^[a-f0-9]{64}$/.test(asset.sha256)) throw new Error("Invalid speech asset manifest");
    const url = new URL(asset.path, base);
    if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname) || urls.has(url.href)) throw new Error("Speech asset outside allowlist");
    total += asset.bytes;
    urls.set(url.href, asset);
  }
  if (!urls.size || urls.size > 20 || total > 100_000_000) throw new Error("Speech pack exceeds allowed bounds");
  return urls;
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
export async function prepareSpeechAssets(urls: ReadonlyMap<string, SpeechAsset>, cache: SpeechAssetCache, download: typeof fetch, status: (message: string) => void, options: SpeechPreparation = { source: "cache" }): Promise<void> {
  if (!options || !["cache", "download", "import"].includes(options.source)) throw new Error("Invalid speech preparation source");
  let checked = 0;
  const total = [...urls.values()].reduce((sum, asset) => sum + asset.bytes, 0);
  if (options.source === "download") for (const asset of urls.values()) distributionUrl(asset);
  if (options.source === "import") {
    if (!(options.file instanceof Blob) || options.file.size !== total + 8) throw new Error("Speech import has incorrect total size");
    const header = new Uint8Array(await options.file.slice(0, 8).arrayBuffer());
    if (!header.every((byte, index) => byte === "PIVOICE1".charCodeAt(index))) throw new Error("Invalid speech import header");
  }
  for (const [url, asset] of urls) {
    if (options.source === "import") {
      const slice = options.file.slice(8 + checked, 8 + checked + asset.bytes);
      await cache.put(url, new Response(await verifiedAsset(new Response(slice), asset)));
    } else {
      const cached = await cache.match(url);
      let response = cached;
      if (!response) {
        if (options.source !== "download") throw new Error("Speech pack missing; explicitly download or import to prepare");
        response = await download(distributionUrl(asset), { method: "GET", credentials: "omit", referrerPolicy: "no-referrer", redirect: "follow", cache: "no-store" });
        checkDownloadResponse(response, asset);
      }
      const bytes = await verifiedAsset(response, asset);
      if (!cached) await cache.put(url, new Response(bytes));
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

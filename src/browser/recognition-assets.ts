export interface SpeechAsset { path: string; bytes: number; sha256: string; }
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
  if (!response.ok || response.redirected || !response.body) throw new Error(`Speech asset unavailable: ${asset.path}`);
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

/** Only this explicit preparation step can fetch. Every file is verified, including cache hits.
 * No complete marker is trusted: all entries must exist and verify on each preparation.
 */
export async function prepareSpeechAssets(urls: ReadonlyMap<string, SpeechAsset>, cache: SpeechAssetCache, download: typeof fetch, status: (message: string) => void): Promise<void> {
  let checked = 0;
  const total = [...urls.values()].reduce((sum, asset) => sum + asset.bytes, 0);
  for (const [url, asset] of urls) {
    const cached = await cache.match(url);
    const response = cached ?? await download(url, { method: "GET", credentials: "same-origin", redirect: "error", cache: "no-store" });
    const bytes = await verifiedAsset(response, asset);
    if (!cached) await cache.put(url, new Response(bytes));
    checked += asset.bytes;
    status(`Local speech pack checked ${checked} / ${total} bytes`);
  }
}

/** A cache miss is an error, never a fetch. Reject bodies, credentials, queries and off-list URLs. */
export function cacheOnlySpeechFetch(urls: ReadonlyMap<string, SpeechAsset>, cache: SpeechAssetCache): typeof fetch {
  return async (input, init) => {
    const request = input instanceof Request ? input : undefined;
    const url = request?.url ?? String(input);
    if ((init?.method ?? request?.method ?? "GET").toUpperCase() !== "GET" || init?.body != null || request?.body || init?.headers || request?.headers.has("authorization")) throw new Error("Speech runtime only permits asset GETs");
    const asset = urls.get(url);
    if (!asset) throw new Error("Speech runtime asset URL is not allowlisted");
    const response = await cache.match(url);
    if (!response) throw new Error("Speech pack evicted; prepare explicitly to restore");
    return new Response(await verifiedAsset(response, asset), { headers: { "Content-Type": asset.path.endsWith(".wasm") ? "application/wasm" : "application/octet-stream" } });
  };
}

import { speechAssetUrls, type SpeechAsset } from "./speech-assets.js";
import { speechPackKind, type SpeechPackKind } from "./speech-pack-kind.js";

export interface SpeechPackInfo {
  kind: SpeechPackKind;
  cacheName: string;
  assets: readonly SpeechAsset[];
}
export type SpeechCacheState = { state: "missing" | "partial" | "present-unverified"; presentFiles: number; totalFiles: number; totalBytes: number };

function checkOwner(pack: SpeechPackInfo) {
  const prefix = speechPackKind(pack.kind) === "tts" ? "pi-voice-tts" : "pi-voice-speech";
  if (!new RegExp(`^${prefix}-[a-f0-9]{24}$`).test(pack.cacheName)) throw new Error("Invalid plugin speech cache identity");
}

/** Presence is not integrity or initialized readiness. Inspection never creates a missing cache. */
export async function inspectSpeechCache(pack: SpeechPackInfo, base: URL, storage: CacheStorage = caches): Promise<SpeechCacheState> {
  checkOwner(pack);
  const urls = speechAssetUrls(base, pack.assets, pack.kind);
  const result: SpeechCacheState = { state: "missing", presentFiles: 0, totalFiles: urls.size,
    totalBytes: [...urls.values()].reduce((total, asset) => total + asset.bytes, 0) };
  if (!await storage.has(pack.cacheName)) return result;
  const cache = await storage.open(pack.cacheName);
  for (const url of urls.keys()) if (await cache.match(url)) result.presentFiles++;
  result.state = result.presentFiles === result.totalFiles ? "present-unverified" : result.presentFiles ? "partial" : "missing";
  return result;
}

/** Caller must first acquire page ownership and safely stop this pack's runtime.
 * Delete only the exact compiled revision; never enumerate/prune another tab's caches.
 */
export async function clearSpeechCache(pack: SpeechPackInfo, storage: CacheStorage = caches): Promise<void> {
  checkOwner(pack);
  await storage.delete(pack.cacheName);
}

import assert from "node:assert/strict";
import test from "node:test";
import { clearSpeechCache, inspectSpeechCache, type SpeechPackInfo } from "../src/browser/speech-cache.ts";

const info: SpeechPackInfo = { kind: "recognition", cacheName: "pi-voice-speech-0123456789abcdef01234567", assets: [
  { path: "models/test/config.json", bytes: 20, sha256: "0".repeat(64) },
  { path: "ort/runtime.wasm", bytes: 30, sha256: "1".repeat(64) },
] };
const base = new URL("https://example.test/nested/speech-cache/");
function storage() {
  const entries = new Set<string>();
  const deleted: string[] = [];
  let exists = false, opened = 0;
  return { entries, deleted, get opened() { return opened; }, setExists(value: boolean) { exists = value; },
    cache: {
      has: async (name: string) => { assert.equal(name, info.cacheName); return exists; },
      open: async (name: string) => { assert.equal(name, info.cacheName); opened++; return { match: async (url: string) => entries.has(url) ? new Response("unverified") : undefined }; },
      delete: async (name: string) => { deleted.push(name); return exists; },
    } as unknown as CacheStorage,
  };
}

test("cache inspection distinguishes presence from readiness and never creates missing caches", async () => {
  const f = storage();
  assert.deepEqual(await inspectSpeechCache(info, base, f.cache), { state: "missing", presentFiles: 0, totalFiles: 2, totalBytes: 50 });
  assert.equal(f.opened, 0);
  f.setExists(true);
  f.entries.add(new URL(info.assets[0].path, base).href);
  assert.equal((await inspectSpeechCache(info, base, f.cache)).state, "partial");
  f.entries.add(new URL(info.assets[1].path, base).href);
  assert.equal((await inspectSpeechCache(info, base, f.cache)).state, "present-unverified");
  assert.deepEqual(f.deleted, []);
});

test("cache clearing deletes only the exact plugin-owned pack identity and propagates storage failures", async () => {
  const f = storage();
  await clearSpeechCache(info, f.cache);
  assert.deepEqual(f.deleted, [info.cacheName]);
  for (const cacheName of ["host-cache", "pi-voice-speech-", "pi-voice-tts-0123456789abcdef01234567", "pi-voice-speech-0123456789abcdef01234567-old"]) {
    await assert.rejects(clearSpeechCache({ ...info, cacheName }, f.cache), /identity/);
  }
  assert.equal(f.deleted.length, 1);
  const bad = { delete: async () => { throw new Error("Storage unavailable"); } } as unknown as CacheStorage;
  await assert.rejects(clearSpeechCache(info, bad), /Storage unavailable/);
});

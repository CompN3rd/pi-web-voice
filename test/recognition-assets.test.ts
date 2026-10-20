import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { cacheOnlySpeechFetch, prepareSpeechAssets, speechAssetUrls, verifiedAsset, type SpeechAssetCache } from "../src/browser/recognition-assets.ts";

const bytes = new Uint8Array([1, 2, 3]);
const asset = { path: "models/onnx-community/whisper-tiny.en/config.json", bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
const base = new URL("https://host.example/non-root/plugin/browser/speech/");
const urls = speechAssetUrls(base, [asset]);
const url = new URL(asset.path, base).href;
function memoryCache() {
  const entries = new Map<string, Response>();
  const cache: SpeechAssetCache = { match: async url => entries.get(url)?.clone(), put: async (url, response) => { entries.set(url, response.clone()); } };
  return { cache, entries };
}

test("speechAssetUrls preserves module-relative host paths and rejects unbounded/untrusted manifests", () => {
  assert.ok(urls.has("https://host.example/non-root/plugin/browser/speech/" + asset.path));
  for (const path of ["https://evil/model", "/models/file", "models/../secret", "ort//file", "ort/file?audio=secret", "ort/%2e%2e/file"]) {
    assert.throws(() => speechAssetUrls(base, [{ ...asset, path }]));
  }
  assert.throws(() => speechAssetUrls(base, [{ ...asset, bytes: 100_000_001 }]));
  assert.throws(() => speechAssetUrls(base, [asset, asset]));
});

test("prepareSpeechAssets downloads only in explicit prepare with integrity, then uses cache", async () => {
  const { cache } = memoryCache();
  let requests = 0;
  const download: typeof fetch = async (input, init) => {
    requests++;
    assert.equal(String(input), url);
    assert.equal(init?.redirect, "error");
    assert.equal(init?.body, undefined);
    return new Response(bytes);
  };
  await prepareSpeechAssets(urls, cache, download, () => {});
  await prepareSpeechAssets(urls, cache, download, () => {});
  assert.equal(requests, 1);
  assert.deepEqual(new Uint8Array(await (await cacheOnlySpeechFetch(urls, cache)(url)).arrayBuffer()), bytes);
});

test("cacheOnlySpeechFetch has no network fallback on eviction and refuses off-list requests or audio bodies", async () => {
  const { cache, entries } = memoryCache();
  await cache.put(url, new Response(bytes));
  const localFetch = cacheOnlySpeechFetch(urls, cache);
  for (const target of ["https://cdn.jsdelivr.net/file", "https://huggingface.co/model", url + "?audio=pcm", url + "#fragment", new URL("../../server", base).href]) {
    await assert.rejects(localFetch(target), /allowlisted/);
  }
  await assert.rejects(localFetch(url, { method: "POST", body: bytes }), /GETs/);
  await assert.rejects(localFetch(url, { headers: { Authorization: "secret" } }), /GETs/);
  entries.clear();
  await assert.rejects(localFetch(url), /evicted/);
});

test("verifiedAsset rejects missing, oversized, truncated and tampered bytes, including corrupted cache", async () => {
  for (const response of [new Response(null, { status: 404 }), new Response(new Uint8Array(4)), new Response(new Uint8Array(2)), new Response(new Uint8Array(3))]) {
    await assert.rejects(verifiedAsset(response, asset));
  }
  const { cache } = memoryCache();
  await cache.put(url, new Response(new Uint8Array(3)));
  await assert.rejects(cacheOnlySpeechFetch(urls, cache)(url), /integrity/);
  await assert.rejects(prepareSpeechAssets(urls, cache, async () => { throw new Error("must not retry corrupt cached assets"); }, () => {}), /integrity/);
});

test("speech pack pins public provenance, revision, only q8 encoder/merged decoder, and hashes", async () => {
  const pack = JSON.parse(await readFile(new URL("../scripts/speech-pack.json", import.meta.url), "utf8"));
  assert.equal(pack.transformers, "3.8.1");
  assert.equal(pack.onnxRuntime, "1.22.0-dev.20250409-89f8206ba4");
  assert.match(pack.revision, /^[a-f0-9]{40}$/);
  assert.ok(pack.provenance.endsWith(pack.revision));
  assert.deepEqual(pack.files.filter((file: { path: string }) => file.path.endsWith(".onnx")).map((file: { path: string }) => file.path), ["onnx/encoder_model_quantized.onnx", "onnx/decoder_model_merged_quantized.onnx"]);
  for (const file of pack.files) assert.match(file.sha256, /^[a-f0-9]{64}$/);
});

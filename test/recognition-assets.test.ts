import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { cacheOnlySpeechFetch, prepareSpeechAssets, speechAssetUrls, verifiedAsset, type SpeechAssetCache } from "../src/browser/recognition-assets.ts";

const bytes = new Uint8Array([1, 2, 3]);
const asset = { path: "models/onnx-community/whisper-tiny.en/config.json", bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), downloadUrl: "https://huggingface.co/onnx-community/whisper-tiny.en/resolve/2575352d61be1bf7225cf8f8b268a4678025fc58/config.json" };
const base = new URL("https://host.example/non-root/plugin/browser/speech-cache/");
const urls = speechAssetUrls(base, [asset]);
const url = new URL(asset.path, base).href;
function memoryCache() {
  const entries = new Map<string, Response>();
  const cache: SpeechAssetCache = { match: async url => entries.get(url)?.clone(), put: async (url, response) => { entries.set(url, response.clone()); } };
  return { cache, entries };
}

test("speechAssetUrls preserves module-relative host paths and rejects unbounded/untrusted manifests", () => {
  assert.ok(urls.has("https://host.example/non-root/plugin/browser/speech-cache/" + asset.path));
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
    assert.equal(String(input), asset.downloadUrl);
    assert.equal(init?.redirect, "follow");
    assert.equal(init?.credentials, "omit");
    assert.equal(init?.referrerPolicy, "no-referrer");
    assert.equal(init?.headers, undefined);
    assert.equal(init?.body, undefined);
    return downloaded(bytes);
  };
  await prepareSpeechAssets(urls, cache, download, () => {}, { source: "download" });
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

function downloaded(body = bytes, finalUrl = asset.downloadUrl): Response {
  const response = new Response(body);
  Object.defineProperties(response, { url: { value: finalUrl }, redirected: { value: finalUrl !== asset.downloadUrl } });
  return response;
}
const noDownload: typeof fetch = async () => { assert.fail("Unexpected network call"); };
function importFile(parts: BlobPart[] = [bytes]): Blob { return new Blob(["PIVOICE1", ...parts]); }

test("prepareSpeechAssets defaults to cache only, checks every entry and never downloads misses", async () => {
  const { cache } = memoryCache();
  await assert.rejects(prepareSpeechAssets(urls, cache, noDownload, () => {}), /missing/);
  await cache.put(url, new Response(bytes));
  await prepareSpeechAssets(urls, cache, noDownload, () => {});
  const extra = { ...asset, path: "ort/other.wasm" };
  await assert.rejects(prepareSpeechAssets(speechAssetUrls(base, [asset, extra]), cache, noDownload, () => {}), /missing/);
});

test("prepareSpeechAssets import validates bounded header, exact total and each ordered hash without network", async () => {
  const secondBytes = new Uint8Array([4, 5]);
  const second = { path: "ort/second.wasm", bytes: 2, sha256: createHash("sha256").update(secondBytes).digest("hex") };
  const manifest = speechAssetUrls(base, [asset, second]);
  const { cache, entries } = memoryCache();
  const file = importFile([bytes, secondBytes]);
  const slices: number[][] = [];
  const slice = file.slice.bind(file);
  file.slice = (start = 0, end = file.size) => { slices.push([start, end]); return slice(start, end); };
  await prepareSpeechAssets(manifest, cache, noDownload, () => {}, { source: "import", file });
  assert.deepEqual(slices, [[0, 8], [8, 11], [11, 13]]);
  assert.equal(entries.size, 2);
  await prepareSpeechAssets(manifest, cache, noDownload, () => {});
  for (const bad of [new Blob(["NOTVOICE", bytes, secondBytes]), importFile([bytes]), importFile([bytes, secondBytes, bytes]), importFile([secondBytes, bytes]), importFile([bytes, new Uint8Array(2)])]) {
    await assert.rejects(prepareSpeechAssets(manifest, cache, noDownload, () => {}, { source: "import", file: bad }));
  }
});

test("prepareSpeechAssets failed import preserves verified partial cache but cannot make missing pack ready", async () => {
  const second = { ...asset, path: "ort/second.wasm" };
  const manifest = speechAssetUrls(base, [asset, second]);
  const { cache, entries } = memoryCache();
  await assert.rejects(prepareSpeechAssets(manifest, cache, noDownload, () => {}, { source: "import", file: importFile([bytes, new Uint8Array(3)]) }), /integrity/);
  assert.equal(entries.size, 1);
  await assert.rejects(prepareSpeechAssets(manifest, cache, noDownload, () => {}), /missing/);
});

test("prepareSpeechAssets download rejects absent/arbitrary URLs before network and untrusted final origins", async () => {
  const { cache } = memoryCache();
  for (const downloadUrl of [undefined, url, "https://evil.example/model", asset.downloadUrl + "?secret=1", asset.downloadUrl.replace("https:", "http:")]) {
    await assert.rejects(prepareSpeechAssets(speechAssetUrls(base, [{ ...asset, downloadUrl }]), cache, noDownload, () => {}, { source: "download" }), /fixed distribution/);
  }
  for (const final of ["http://huggingface.co/file", "https://user:secret@huggingface.co/file", "https://evil.example/file", "https://huggingface.co.evil.example/file", "https://us.aws.cdn.hf.co.evil.example/file", "https://huggingface.co:444/file"]) {
    await assert.rejects(prepareSpeechAssets(urls, cache, async () => downloaded(bytes, final), () => {}, { source: "download" }), /known HTTPS/);
  }
  for (const final of ["https://huggingface.co/api/resolve-cache/file", "https://us.aws.cdn.hf.co/xet-bridge-us/file?signed=value", "https://cas-bridge.xethub.hf.co/file?signed=value"]) {
    await prepareSpeechAssets(urls, memoryCache().cache, async () => downloaded(bytes, final), () => {}, { source: "download" });
  }
  await assert.rejects(prepareSpeechAssets(urls, cache, async () => downloaded(new Uint8Array(3)), () => {}, { source: "download" }), /integrity/);
});

test("prepareSpeechAssets runtime downloads only fixed jsdelivr version and rejects model CDN finals", async () => {
  const runtime = { ...asset, path: "ort/ort-wasm-simd-threaded.jsep.wasm", downloadUrl: "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0-dev.20250409-89f8206ba4/dist/ort-wasm-simd-threaded.jsep.wasm" };
  const manifest = speechAssetUrls(base, [runtime]);
  await prepareSpeechAssets(manifest, memoryCache().cache, async input => {
    assert.equal(input, runtime.downloadUrl);
    return downloaded(bytes, runtime.downloadUrl);
  }, () => {}, { source: "download" });
  await assert.rejects(prepareSpeechAssets(manifest, memoryCache().cache, async () => downloaded(), () => {}, { source: "download" }), /known HTTPS/);
});

test("cacheOnlySpeechFetch rejects credential-bearing requests and rechecks imported integrity", async () => {
  const { cache } = memoryCache();
  await prepareSpeechAssets(urls, cache, noDownload, () => {}, { source: "import", file: importFile() });
  const fetch = cacheOnlySpeechFetch(urls, cache);
  await assert.rejects(fetch(url, { credentials: "include" }), /GETs/);
  await assert.rejects(fetch(new Request(url, { credentials: "include" })), /GETs/);
  await assert.rejects(fetch(new Request(url, { headers: { authorization: "secret" } })), /GETs/);
  await cache.put(url, new Response(new Uint8Array(3)));
  await assert.rejects(fetch(url), /integrity/);
});

test("prepareSpeechAssets rejects malformed preparation messages without cache or network action", async () => {
  const cache: SpeechAssetCache = { match: async () => assert.fail("unexpected cache read"), put: async () => assert.fail("unexpected cache write") };
  for (const options of [null, {}, { source: "remote" }, { source: "import" }, { source: "import", file: { size: 11 } }]) {
    await assert.rejects(prepareSpeechAssets(urls, cache, noDownload, () => {}, options as never));
  }
});

import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { cacheOnlySpeechFetch, prepareSpeechAssets, speechAssetUrls, type SpeechAsset, type SpeechAssetCache } from "../src/browser/speech-assets.ts";
import { SPEECH_PACKS, speechPackKind } from "../src/browser/speech-pack-kind.ts";

const base = new URL("https://example.test/nested/plugin/browser/tts-cache/");
const model = "models/onnx-community/Kokoro-82M-v1.0-ONNX/";
const revision = "1939ad2a8e416c0acfeecc08a694d14ef25f2231";
const paths = [model + "onnx/model_quantized.onnx", model + "voices/af_heart.bin", "phonemizer/phonemizer.js"];
const bytes = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5]), new Uint8Array([6, 7, 8, 9])];
const assets: SpeechAsset[] = paths.map((path, i) => ({ path, bytes: bytes[i].length,
  sha256: createHash("sha256").update(bytes[i]).digest("hex"),
  downloadUrl: path.startsWith(model) ? `https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/${revision}/${path.slice(model.length)}`
    : "https://cdn.jsdelivr.net/npm/phonemizer@1.2.1/dist/phonemizer.js",
}));
const noDownload: typeof fetch = async () => assert.fail("Unexpected distribution request");
function fixture() {
  const entries = new Map<string, Response>();
  const cache: SpeechAssetCache = {
    match: async url => entries.get(url)?.clone(),
    put: async (url, response) => { entries.set(url, response.clone()); },
  };
  return { entries, cache, urls: speechAssetUrls(base, assets, "tts") };
}
function pack(payload = bytes, magic = "PIVOTTS1") { return new Blob([magic, ...payload]); }
function downloaded(body: Uint8Array, url: string) {
  const response = new Response(body as Uint8Array<ArrayBuffer>);
  Object.defineProperty(response, "url", { value: url });
  return response;
}

test("TTS descriptors are separate, bounded and reject untrusted paths and pack kinds", () => {
  const urls = speechAssetUrls(base, assets, "tts");
  assert.equal(urls.kind, "tts");
  assert.equal([...urls.keys()][2], new URL("phonemizer/phonemizer.js", base).href);
  const weight = { ...assets[0], bytes: 92_361_116 };
  assert.equal(speechAssetUrls(base, [weight], "tts").size, 1);
  assert.throws(() => speechAssetUrls(base, [weight]), /manifest/);
  for (const path of ["../voice.bin", "models/other/config.json", model + "voices/am_adam.bin", "phonemizer/other.js", "ort/other.wasm"]) {
    assert.throws(() => speechAssetUrls(base, [{ ...assets[0], path }], "tts"), /manifest/);
  }
  for (const size of [NaN, Infinity, 0, -1, 1.5, SPEECH_PACKS.tts.maxFileBytes + 1]) {
    assert.throws(() => speechAssetUrls(base, [{ ...assets[0], bytes: size }], "tts"));
  }
  assert.throws(() => speechAssetUrls(base, [assets[0], assets[0]], "tts"), /allowlist/);
  assert.throws(() => speechAssetUrls(base, [weight, { ...assets[1], bytes: 40_000_000 }], "tts"), /bounds/);
  for (const kind of ["other", "__proto__", null, undefined]) assert.throws(() => speechPackKind(kind), /Unknown/);
});

test("TTS import is network-free and checks its own header, ordered assets and exact total", async () => {
  const { cache, urls, entries } = fixture();
  for (const file of [pack(bytes, "PIVOICE1"), pack(bytes, "PIVOTTS2"), new Blob([pack(), "extra"]), pack().slice(0, -1)]) {
    await assert.rejects(prepareSpeechAssets(urls, cache, noDownload, () => {}, { source: "import", file }));
    assert.equal(entries.size, 0);
  }
  const progress: string[] = [];
  await prepareSpeechAssets(urls, cache, noDownload, message => progress.push(message), { source: "import", file: pack() });
  assert.equal(entries.size, assets.length);
  assert.equal(progress.length, assets.length);
  await prepareSpeechAssets(urls, cache, noDownload, () => {});
  const fetch = cacheOnlySpeechFetch(urls, cache);
  for (let i = 0; i < assets.length; i++) assert.deepEqual(new Uint8Array(await (await fetch(new URL(assets[i].path, base))).arrayBuffer()), bytes[i]);
  const recognition = speechAssetUrls(base, [assets[0]]);
  await assert.rejects(prepareSpeechAssets(recognition, cache, noDownload, () => {}, { source: "import", file: pack([bytes[0]]) }), /header/);
});

test("TTS verifies every model, voice and phonemizer entry on import and on later use", async () => {
  for (let i = 0; i < assets.length; i++) {
    const { cache, urls, entries } = fixture();
    const corrupt = bytes.map((body, index) => index === i ? new Uint8Array(body.length) : body);
    await assert.rejects(prepareSpeechAssets(urls, cache, noDownload, () => {}, { source: "import", file: pack(corrupt) }), /integrity/);
    assert.equal(entries.size, i); // Earlier verified entries may survive; the failed one is never published.
    await assert.rejects(prepareSpeechAssets(urls, cache, noDownload, () => {}), /missing/);
    await prepareSpeechAssets(urls, cache, noDownload, () => {}, { source: "import", file: pack() });
    const url = new URL(assets[i].path, base).href;
    entries.set(url, new Response(corrupt[i]));
    await assert.rejects(cacheOnlySpeechFetch(urls, cache)(url), /integrity/);
    entries.delete(url);
    await assert.rejects(cacheOnlySpeechFetch(urls, cache)(url), /evicted/);
  }
});

test("TTS download uses exact pinned sources and replaces corrupt bytes only on explicit download", async () => {
  const { cache, urls, entries } = fixture();
  await prepareSpeechAssets(urls, cache, noDownload, () => {}, { source: "import", file: pack() });
  for (let i = 0; i < assets.length; i++) {
    const asset = assets[i];
    const url = new URL(asset.path, base).href;
    entries.set(url, new Response(new Uint8Array(asset.bytes)));
    await assert.rejects(prepareSpeechAssets(urls, cache, noDownload, () => {}), /integrity/);
    let calls = 0;
    await prepareSpeechAssets(urls, cache, async (input, init) => {
      calls++;
      assert.equal(input, asset.downloadUrl);
      assert.equal(init?.credentials, "omit");
      assert.equal(init?.referrerPolicy, "no-referrer");
      return downloaded(bytes[i], asset.downloadUrl!);
    }, () => {}, { source: "download" });
    assert.equal(calls, 1);
  }
  for (const downloadUrl of [undefined, "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/voices/af_heart.bin", "https://other.test/code.js"]) {
    const bad = speechAssetUrls(base, [{ ...assets[1], downloadUrl }], "tts");
    await assert.rejects(prepareSpeechAssets(bad, cache, noDownload, () => {}, { source: "download" }), /fixed distribution/);
  }
  const phonemizer = speechAssetUrls(base, [assets[2]], "tts");
  for (const final of ["https://huggingface.co/phonemizer.js", "http://cdn.jsdelivr.net/phonemizer.js", "https://evil.test/phonemizer.js"]) {
    await assert.rejects(prepareSpeechAssets(phonemizer, fixture().cache, async () => downloaded(bytes[2], final), () => {}, { source: "download" }), /known HTTPS/);
  }
});

test("TTS cache failures do not claim readiness or fall back to network", async () => {
  const { urls } = fixture();
  await assert.rejects(prepareSpeechAssets(urls, {
    match: async () => { throw new Error("Cache unavailable"); }, put: async () => assert.fail("unexpected put"),
  }, noDownload, () => {}), /Cache unavailable/);
  let progress = 0;
  await assert.rejects(prepareSpeechAssets(urls, {
    match: async () => undefined, put: async () => { throw new Error("Quota exhausted"); },
  }, noDownload, () => { progress++; }, { source: "import", file: pack() }), /Quota exhausted/);
  assert.equal(progress, 0);
});

test("candidate inventory pins immutable model/voice/phonemizer bytes without changing recognition limits", async () => {
  const metadata = JSON.parse(await readFile(new URL("../scripts/tts-pack.json", import.meta.url), "utf8"));
  assert.equal(metadata.revision, revision);
  assert.equal(metadata.voice, "af_heart");
  assert.equal(metadata.sampleRate, 24_000);
  assert.equal(metadata.phonemizer.sha256, "193481f474f7c1ea81df3195d18b45df8ef7254dbdccb3f193d60215c4897bec");
  const inventory = metadata.files.filter((file: SpeechAsset) => file.path !== "README.md").map((file: SpeechAsset) => ({ ...file, path: model + file.path }));
  inventory.push(metadata.phonemizer);
  assert.equal(speechAssetUrls(base, inventory, "tts").size, 6);
  assert.equal(SPEECH_PACKS.recognition.magic, "PIVOICE1");
  assert.equal(SPEECH_PACKS.recognition.maxFileBytes, 64_000_000);
  assert.equal(SPEECH_PACKS.recognition.maxTotalBytes, 100_000_000);
  assert.equal(SPEECH_PACKS.recognition.maxFiles, 20);
});

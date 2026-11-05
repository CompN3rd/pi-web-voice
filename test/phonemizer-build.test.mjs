import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../scripts/phonemizer/", import.meta.url);
const read = name => readFile(new URL(name, root));
const pins = JSON.parse(await read("pins.json"));
const candidate = JSON.parse(await read("candidate.json"));

test("phonemizer-build: measured candidate maps to exact native/toolchain and current builder sources", async () => {
  assert.deepEqual(candidate.pins, pins);
  assert.equal(pins.nativeRevision, "4870adfa25b1a32b4361592f1be8a40337c58d6c");
  assert.equal(pins.emscriptenVersion, "3.1.74");
  assert.equal(candidate.combinedCandidateLicense, "GPL-3.0-or-later");
  assert.equal(candidate.productionIntegrated, false);
  assert.deepEqual(candidate.patches, []);
  for (const input of pins.inputs) {
    assert.match(input.url, /^https:\/\//);
    assert.match(input.sha256, /^[a-f0-9]{64}$/);
    assert.ok(!/latest|\/main\//.test(input.url));
  }
  for (const [name, expected] of Object.entries(candidate.builderInputs)) {
    const bytes = await read(name);
    assert.equal(bytes.length, expected.bytes, name);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), expected.sha256, name);
  }
  for (const artifact of [candidate.binary, candidate.sourceArchive, candidate.notices, ...Object.values(candidate.data)]) {
    assert.ok(artifact.bytes > 0);
    assert.match(artifact.sha256, /^[a-f0-9]{64}$/);
  }
  assert.deepEqual(Object.keys(candidate.data).sort(), ["en_dict", "intonations", "lang/gmw/en", "lang/gmw/en-US", "phondata", "phonindex", "phontab"]);
});

test("phonemizer-build: production pins measured replacement with no download URL", async () => {
  const production = JSON.parse(await readFile(new URL("../scripts/tts-pack.json", import.meta.url)));
  assert.equal(production.phonemizer.sha256, candidate.binary.sha256);
  assert.equal(production.phonemizer.downloadUrl, undefined);
  assert.equal(production.acquisition, "import-only");
  assert.equal(candidate.binary.downloadUrl, undefined);
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url)));
  assert.equal(packageJson.private, true);
  assert.equal(packageJson.license, "MIT");
});

let identity = 0;
async function wrapper(options = {}) {
  const source = await read("phonemizer.mjs");
  // A fresh factory/module per test, without native bytes or any network.
  const fixture = `
    export const stats = { factories: 0, allocations: 0, frees: 0, input: "", pending: false };
    const options = ${JSON.stringify(options)};
    async function createEspeak() {
      stats.factories++;
      if (options.startupFailure) throw Error("startup");
      return {
        _pv_init: () => options.initFailure ? -1 : 0,
        _malloc: () => { stats.allocations++; return options.allocationFailure ? 0 : 8; },
        _free: () => { stats.frees++; },
        lengthBytesUTF8: text => text.length,
        stringToUTF8: text => { stats.input = text; },
        _pv_begin: () => { stats.pending = true; },
        _pv_pending: () => stats.pending,
        _pv_next: () => { stats.pending = false; return options.conversionFailure ? 0 : 16; },
        UTF8ToString: () => stats.input
      };
    }
  `;
  return import(`data:text/javascript;base64,${Buffer.from(fixture + source + `\n// ${identity++}`).toString("base64")}`);
}

test("phonemizer-build: English wrapper validates before lazy startup and serializes native cursor ownership", async () => {
  const module = await wrapper();
  assert.deepEqual(await module.phonemize(" ", "en-us"), []);
  for (const [text, language] of [["Hello", "en"], ["a\0b", "en-us"], ["x".repeat(1001), "en-us"], [5, "en-us"]])
    await assert.rejects(module.phonemize(text, language), /Unsupported/);
  assert.equal(module.stats.factories, 0);
  const words = ["Hello", "world", "again"];
  assert.deepEqual(await Promise.all(words.map(text => module.phonemize(text, "en-us"))), words.map(word => [word]));
  assert.equal(module.stats.factories, 1);
  assert.equal(module.stats.allocations, 3);
  assert.equal(module.stats.frees, 3);
});

test("phonemizer-build: initialization failure is sticky; allocation/conversion errors fail closed", async () => {
  for (const options of [{ startupFailure: true }, { initFailure: true }]) {
    const module = await wrapper(options);
    await assert.rejects(module.phonemize("Hello", "en-us"));
    await assert.rejects(module.phonemize("Hello", "en-us"));
    assert.equal(module.stats.factories, 1);
    assert.equal(module.stats.allocations, 0);
  }
  const allocation = await wrapper({ allocationFailure: true });
  await assert.rejects(allocation.phonemize("Hello", "en-us"), /allocation/);
  assert.equal(allocation.stats.frees, 0);
  const conversion = await wrapper({ conversionFailure: true });
  await assert.rejects(conversion.phonemize("Hello", "en-us"), /conversion/);
  assert.equal(conversion.stats.frees, 1);
});

import assert from "node:assert/strict";
import test from "node:test";
import { ttsPrefix, validTtsPcm, TTS_MAX_CHUNK_SAMPLES } from "../src/browser/tts-contract.ts";

test("TTS prefix is bounded without splitting a surrogate pair", () => {
  for (const [input, expected] of [["Short 😀", "Short 😀"], ["x".repeat(999) + "😀tail", "x".repeat(999)],
    ["x".repeat(998) + "😀tail", "x".repeat(998) + "😀"], ["x".repeat(1001), "x".repeat(1000)]]) {
    assert.equal(ttsPrefix(input), expected);
  }
});

test("TTS PCM contract rejects invalid type, length, amplitude and nonfinite samples", () => {
  for (const value of [null, [], new Float64Array([0.2]), new Float32Array(), new Float32Array(TTS_MAX_CHUNK_SAMPLES + 1),
    new Float32Array([NaN]), new Float32Array([Infinity]), new Float32Array([-Infinity]), new Float32Array([1.01]), new Float32Array([-1.01])]) {
    assert.equal(validTtsPcm(value), false);
  }
  assert.equal(validTtsPcm(new Float32Array([-1, 0, 1])), true);
  assert.equal(validTtsPcm(new Float32Array(TTS_MAX_CHUNK_SAMPLES)), true);
});

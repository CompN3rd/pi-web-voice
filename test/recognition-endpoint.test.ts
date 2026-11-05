import assert from "node:assert/strict";
import test from "node:test";
import { PauseEndpoint } from "../src/browser/recognition-endpoint.ts";

test("PauseEndpoint requires activity before quiet, independent of PCM chunk boundaries", () => {
  for (const size of [1, 127, 320, 1024]) {
    const endpoint = new PauseEndpoint();
    assert.equal(endpoint.push(new Float32Array(32000)), false, "silence alone never finishes");
    const speech = new Float32Array(4800).fill(0.1);
    for (let i = 0; i < speech.length; i += size) assert.equal(endpoint.push(speech.subarray(i, i + size)), false);
    assert.equal(endpoint.push(new Float32Array(19199)), false);
    assert.equal(endpoint.push(new Float32Array(1)), true);
  }
});
test("PauseEndpoint ignores short noise and activity resets the quiet interval", () => {
  const endpoint = new PauseEndpoint();
  assert.equal(endpoint.push(new Float32Array(320).fill(0.1)), false);
  assert.equal(endpoint.push(new Float32Array(32000)), false);
  assert.equal(endpoint.push(new Float32Array(4800).fill(0.1)), false);
  assert.equal(endpoint.push(new Float32Array(16000)), false);
  assert.equal(endpoint.push(new Float32Array(320).fill(0.1)), false);
  assert.equal(endpoint.push(new Float32Array(16000)), false);
  assert.equal(endpoint.push(new Float32Array(3200)), true);
});

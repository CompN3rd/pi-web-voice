import assert from "node:assert/strict";
import test from "node:test";
import { assertTtsLoaderCapabilities, loadTtsAssets } from "../src/browser/tts-loader.js";

function withoutProperty(target: object, key: PropertyKey, action: () => void): void {
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  try { Object.defineProperty(target, key, { value: undefined, configurable: true }); action(); }
  finally { if (descriptor) Object.defineProperty(target, key, descriptor); else Reflect.deleteProperty(target, key); }
}

test("tts-loader: requires Blob streams, pipeThrough, gzip decompression and async iteration before import", () => {
  assert.doesNotThrow(assertTtsLoaderCapabilities);
  for (const [target, key] of [
    [Blob.prototype, "stream"], [ReadableStream.prototype, "pipeThrough"],
    [ReadableStream.prototype, Symbol.asyncIterator], [globalThis, "DecompressionStream"],
  ] as const) withoutProperty(target, key, () => assert.throws(assertTtsLoaderCapabilities, /TTS prepare/));
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "DecompressionStream")!;
  try {
    Object.defineProperty(globalThis, "DecompressionStream", { configurable: true, value: class {
      constructor(format: string) { assert.equal(format, "gzip"); throw new Error("gzip unsupported"); }
    } });
    assert.throws(assertTtsLoaderCapabilities, /gzip unsupported/);
  } finally { Object.defineProperty(globalThis, "DecompressionStream", descriptor); }
});

test("tts-loader: incapable browsers reject before cache access, acquisition or module import", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "DecompressionStream")!;
  try {
    Object.defineProperty(globalThis, "DecompressionStream", { value: undefined, configurable: true });
    await assert.rejects(loadTtsAssets(new URL("https://example.test/tts-cache/"), [], "unused",
      async () => { throw new Error("must not download"); }, () => { throw new Error("must not install fetch"); },
      { source: "download" }, () => { throw new Error("must not begin acquisition"); }), /TTS prepare/);
  } finally { Object.defineProperty(globalThis, "DecompressionStream", descriptor); }
});

import assert from "node:assert/strict";
import test from "node:test";
import { assertTtsLoaderCapabilities, loadTtsAssets } from "../src/browser/tts-loader.js";

function withoutProperty(target: object, key: PropertyKey, action: () => void): void {
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  try { Object.defineProperty(target, key, { value: undefined, configurable: true }); action(); }
  finally { if (descriptor) Object.defineProperty(target, key, descriptor); else Reflect.deleteProperty(target, key); }
}

test("tts-loader: source-built module needs WASM/blob URLs, not gzip streams", () => {
  assert.doesNotThrow(assertTtsLoaderCapabilities);
  for (const [target, key] of [[globalThis, "Blob"], [globalThis, "WebAssembly"], [URL, "createObjectURL"]] as const)
    withoutProperty(target, key, () => assert.throws(assertTtsLoaderCapabilities, /TTS prepare/));
  for (const [target, key] of [[Blob.prototype, "stream"], [ReadableStream.prototype, "pipeThrough"],
    [ReadableStream.prototype, Symbol.asyncIterator], [globalThis, "DecompressionStream"]] as const)
    withoutProperty(target, key, () => assert.doesNotThrow(assertTtsLoaderCapabilities));
});

test("tts-loader: incapable browsers reject before cache access, acquisition or module import", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "WebAssembly")!;
  try {
    Object.defineProperty(globalThis, "WebAssembly", { value: undefined, configurable: true });
    await assert.rejects(loadTtsAssets(new URL("https://example.test/tts-cache/"), [], "unused",
      async () => { throw new Error("must not download"); }, () => { throw new Error("must not install fetch"); },
      { source: "cache" }, () => { throw new Error("must not begin acquisition"); }), /TTS prepare/);
  } finally { Object.defineProperty(globalThis, "WebAssembly", descriptor); }
});

test("tts-loader: import-only download refusal precedes cache open and capability work", async () => {
  await assert.rejects(loadTtsAssets(new URL("https://example.test/tts-cache/"), [], "unused",
    async () => { throw new Error("must not download"); }, () => { throw new Error("must not install fetch"); },
    { source: "download" }, () => { throw new Error("must not begin acquisition"); }), /TTS download unavailable/);
});

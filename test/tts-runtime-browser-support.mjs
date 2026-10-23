import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { build } from "esbuild";
import { chromium } from "playwright-core";

export async function ttsBrowserHarness({ assets, cache, modelAdapter }) {
  const define = { __TTS_ASSETS__: JSON.stringify(assets), __TTS_CACHE__: JSON.stringify(cache), __TTS_BUILD__: '"tts-browser-test-v1"' };
  const common = { bundle: true, write: false, format: "esm", platform: "browser", target: "es2022", define, logLevel: "silent" };
  const worker = await build({ ...common, entryPoints: ["src/browser/tts-worker.ts"], plugins: modelAdapter ? [{ name: "loader-only-adapter", setup(build) {
    build.onResolve({ filter: /\/tts-adapter\.js$/ }, () => ({ path: "adapter", namespace: "tts-test" }));
    build.onLoad({ filter: /.*/, namespace: "tts-test" }, () => ({ contents: modelAdapter, loader: "js" }));
  } }] : [] });
  const bootstrap = await build({ ...common, entryPoints: ["src/browser/tts-bootstrap.ts"] });
  const runtime = await build({ ...common, entryPoints: ["src/browser/tts-runtime.ts"] });
  // Observe both native transports and guarded attempts from BEFORE module evaluation.
  const instrument = `
    const stats = globalThis.ttsStats = { nativeFetch: 0, nativeXhr: 0, guardedTransports: 0, unexpectedFetch: 0, prepared: false, phonemizerCalls: 0, ortInit: null };
    const fetch = globalThis.fetch.bind(globalThis);
    globalThis.fetch = (...args) => { stats.nativeFetch++; return fetch(...args); };
    const XHR = globalThis.XMLHttpRequest;
    globalThis.XMLHttpRequest = new Proxy(XHR, { construct(target, args) { stats.nativeXhr++; return Reflect.construct(target, args); } });
    const allowedAssets = new Set(${JSON.stringify(assets.map(asset => asset.path))}.map(path => new URL("./tts-cache/" + path, import.meta.url).href));
    const define = Object.defineProperty;
    Object.defineProperty = function(object, key, descriptor) {
      if (object === globalThis && key === "fetch") {
        const guarded = descriptor.value;
        descriptor = { ...descriptor, value: (...args) => { if (!allowedAssets.has(String(args[0]?.url ?? args[0]))) stats.unexpectedFetch++; return guarded(...args); } };
      } else if (object === globalThis && ["XMLHttpRequest", "WebSocket", "EventSource", "Worker", "SharedWorker", "WebTransport", "importScripts"].includes(key)) {
        const guarded = descriptor.value;
        descriptor = { ...descriptor, value: function(...args) { stats.guardedTransports++; return Reflect.apply(guarded, this, args); } };
      }
      return define(object, key, descriptor);
    };
    const open = caches.open.bind(caches);
    caches.open = async name => {
      const cache = await open(name);
      const match = cache.match.bind(cache);
      cache.match = async (...args) => {
        const response = await match(...args);
        const url = String(args[0]);
        const selected = self.name.startsWith("phonemizer") ? url.endsWith("phonemizer.js") : url.endsWith(".wasm");
        if (stats.prepared && selected && self.name.endsWith("evicted")) return undefined;
        if (stats.prepared && selected && self.name.endsWith("corrupt") && response) {
          const bytes = new Uint8Array(await response.arrayBuffer()); bytes[bytes.length - 1] ^= 1; return new Response(bytes);
        }
        return response;
      };
      return cache;
    };
    const post = globalThis.postMessage.bind(globalThis);
    globalThis.postMessage = (message, transfer) => {
      if (message.type === "progress" && message.progress?.phase === "initializing") stats.prepared = true;
      post({ ...message, stats }, transfer);
    };
    if (self.name === "no-decompression") globalThis.DecompressionStream = undefined;
    if (self.name === "no-blob-stream") Blob.prototype.stream = undefined;
    if (self.name === "no-pipe-through") ReadableStream.prototype.pipeThrough = undefined;
    if (self.name === "no-async-iteration") ReadableStream.prototype[Symbol.asyncIterator] = undefined;
    let first;
    globalThis.onmessage = event => { if (first) throw Error("test startup busy"); first = event; };
    await import("./tts-bootstrap.js");
    if (first) globalThis.onmessage(first);
    post({ type: "loaded", stats });
  `;
  const files = new Map([
    ["/nested/voice/tts-worker.js", worker.outputFiles[0].text],
    ["/nested/voice/tts-bootstrap.js", bootstrap.outputFiles[0].text],
    ["/nested/voice/tts-runtime.js", runtime.outputFiles[0].text],
    ["/nested/voice/instrument.js", instrument],
  ]);
  assert.ok(!bootstrap.outputFiles[0].text.includes("StyleTextToSpeech2Model"), "bootstrap must not inline dependency evaluation");
  const executablePath = process.env.VOICE_BROWSER_EXECUTABLE ?? (process.platform === "win32" ? "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" : undefined);
  if (!executablePath || !existsSync(executablePath)) throw new Error("Set VOICE_BROWSER_EXECUTABLE to an installed Chromium/Edge; no browser downloads.");
  const requests = [];
  const server = createServer((request, response) => {
    const path = new URL(request.url, "http://localhost").pathname;
    requests.push(path);
    response.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self' blob: 'wasm-unsafe-eval'; worker-src 'self' blob:; connect-src 'none'; style-src 'none'; img-src 'none'");
    if (path === "/") { response.setHeader("Content-Type", "text/html"); response.end('<!doctype html><title>TTS regression</title><input type="file">'); }
    else if (files.has(path)) { response.setHeader("Content-Type", "text/javascript"); response.end(files.get(path)); }
    else { response.writeHead(404); response.end(); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser;
  try { browser = await chromium.launch({ executablePath, headless: true }); }
  catch (error) { await new Promise(resolve => server.close(resolve)); throw error; }
  return {
    async context(packBytes) {
      const context = await browser.newContext({ serviceWorkers: "block" });
      const unexpected = [];
      await context.route("**/*", route => {
        const url = new URL(route.request().url());
        if (url.origin === origin && (url.pathname === "/" || files.has(url.pathname)) && !url.search && route.request().method() === "GET") return route.continue();
        unexpected.push(url.href); return route.abort();
      });
      const page = await context.newPage();
      await page.goto(origin);
      await page.locator("input").setInputFiles({ name: "tts.pivoice", mimeType: "application/octet-stream", buffer: packBytes });
      await page.evaluate(async () => {
        const poisoned = await caches.open("kokoro-voices");
        await poisoned.put("https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/voices/af_heart.bin", new Response(new Uint8Array([1, 2, 3])));
      });
      return { context, page, unexpected };
    },
    requests,
    async close() { await browser.close(); await new Promise(resolve => server.close(resolve)); },
  };
}

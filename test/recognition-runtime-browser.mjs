import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { build } from "esbuild";
import { chromium } from "playwright-core";

// Run the production worker's preparation and network boundary with the ACTUAL
// pinned ORT glue/WASM. Replace only the Transformers model factory so this
// regression needs neither model weights nor a live provider. This is not an
// inference/accuracy or device acceptance test.
const pack = JSON.parse(await readFile("scripts/speech-pack.json", "utf8"));
const ortPackage = JSON.parse(await readFile("node_modules/onnxruntime-web/package.json", "utf8"));
assert.equal(ortPackage.version, pack.onnxRuntime);
const assets = [];
const runtime = new Map();
for (const name of ["ort-wasm-simd-threaded.jsep.mjs", "ort-wasm-simd-threaded.jsep.wasm"]) {
  const bytes = await readFile(`node_modules/onnxruntime-web/dist/${name}`);
  const path = `ort/${name}`;
  assets.push({ path, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
  runtime.set(`/pi-voice-speech/${path}`, bytes);
}
const cacheName = "pi-voice-runtime-browser-regression";
const adapter = `
export const env = { backends: { onnx: { wasm: {} } } };
export async function pipeline() {
  const wasm = env.backends.onnx.wasm;
  if (wasm.numThreads !== 1 || wasm.proxy !== false || env.allowRemoteModels !== false)
    throw new Error("Unexpected production runtime configuration");
  const cache = await caches.open(${JSON.stringify(cacheName)});
  // Production preparation has already verified both assets, and loaded the
  // verified glue into its blob URL. Now simulate eviction/corruption at the
  // precise boundary before ORT loads WASM.
  const cached = await cache.match(wasm.wasmPaths.wasm);
  if (!cached) throw new Error("Preparation did not cache WASM");
  globalThis.runtimeStats.prepared = true;
  if (self.name === "evicted") await cache.delete(wasm.wasmPaths.wasm);
  if (self.name === "corrupt") {
    const bytes = new Uint8Array(await cached.arrayBuffer());
    bytes[bytes.length - 1] ^= 1;
    await cache.put(wasm.wasmPaths.wasm, new Response(bytes));
  }
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    try { return await originalFetch(...args); }
    catch (error) { globalThis.runtimeStats.fetchErrors.push(String(error)); throw error; }
  };
  const { default: factory } = await import(wasm.wasmPaths.mjs);
  // Same public glue factory options as pinned ORT's wasm-factory.ts. Do not
  // supply wasmBinary or instantiateWasm: exercise its real loading/fallbacks.
  const module = await factory({ numThreads: wasm.numThreads, locateFile: () => wasm.wasmPaths.wasm });
  globalThis.runtimeStats.ortInit = module._OrtInit(1, 2);
  if (globalThis.runtimeStats.ortInit !== 0) throw new Error("ORT initialization failed");
  return async () => { throw new Error("This regression does not run model inference"); };
}
`;
const output = await build({
  entryPoints: ["src/browser/recognition-worker.ts"], bundle: true, write: false,
  format: "esm", platform: "browser", target: "es2022",
  define: { __SPEECH_ASSETS__: JSON.stringify(assets), __SPEECH_CACHE__: JSON.stringify(cacheName) },
  plugins: [{ name: "runtime-only-model-factory", setup(build) {
    build.onResolve({ filter: /^@huggingface\/transformers$/ }, () => ({ path: "model-factory", namespace: "runtime-test" }));
    build.onLoad({ filter: /.*/, namespace: "runtime-test" }, () => ({ contents: adapter, loader: "js" }));
  } }],
});
// Instrument native entrypoints BEFORE importing production code. The guard
// must prevent even constructing native XHR; recording instantiated input hashes
// also distinguishes rejected fetch promises from bytes reaching WebAssembly.
const bootstrap = `
const stats = globalThis.runtimeStats = {
  prepared: false, nativeXhr: 0, instantiatedHashes: [], instantiations: 0, fetchErrors: [], ortInit: null
};
const NativeXHR = globalThis.XMLHttpRequest;
globalThis.XMLHttpRequest = new Proxy(NativeXHR, {
  construct(target, args) { stats.nativeXhr++; return Reflect.construct(target, args); }
});
const digest = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
  byte => byte.toString(16).padStart(2, "0")).join("");
const instantiate = WebAssembly.instantiate.bind(WebAssembly);
WebAssembly.instantiate = async (bytes, imports) => {
  stats.instantiatedHashes.push(bytes instanceof WebAssembly.Module ? "precompiled-module" : await digest(bytes));
  const result = await instantiate(bytes, imports);
  stats.instantiations++;
  return result;
};
const instantiateStreaming = WebAssembly.instantiateStreaming.bind(WebAssembly);
WebAssembly.instantiateStreaming = async (source, imports) => {
  const response = await source;
  stats.instantiatedHashes.push(await digest(await response.clone().arrayBuffer()));
  const result = await instantiateStreaming(response, imports);
  stats.instantiations++;
  return result;
};
const post = globalThis.postMessage.bind(globalThis);
globalThis.postMessage = message => post({ ...message, stats });
await import("./recognition-worker.js");
post({ type: "loaded" });
`;
const executablePath = process.env.VOICE_BROWSER_EXECUTABLE ?? (process.platform === "win32"
  ? "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" : undefined);
if (!executablePath || !existsSync(executablePath)) throw new Error("Set VOICE_BROWSER_EXECUTABLE to an installed Chromium/Edge browser; this test downloads none.");
let requests = [];
const server = createServer((request, response) => {
  const path = new URL(request.url, "http://localhost").pathname;
  requests.push(path);
  if (path === "/") { response.setHeader("Content-Type", "text/html"); response.end("<!doctype html><title>Local ORT regression</title>"); }
  else if (path === "/nested/voice/bootstrap.js" || path === "/nested/voice/recognition-worker.js") {
    response.setHeader("Content-Type", "text/javascript");
    response.end(path.endsWith("bootstrap.js") ? bootstrap : output.outputFiles[0].text);
  } else if (runtime.has(path)) {
    response.setHeader("Content-Type", path.endsWith(".wasm") ? "application/wasm" : "text/javascript");
    response.end(runtime.get(path));
  } else { response.writeHead(404); response.end(); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({ executablePath, headless: true });
  for (const scenario of ["cached", "evicted", "corrupt"]) {
    const context = await browser.newContext({ serviceWorkers: "block" });
    try {
      const unexpectedNetwork = [];
      const allowed = new Set(["/", "/nested/voice/bootstrap.js", "/nested/voice/recognition-worker.js", ...runtime.keys()]);
      await context.route("**/*", route => {
        const url = new URL(route.request().url());
        if (url.origin === origin && allowed.has(url.pathname) && !url.search && route.request().method() === "GET") return route.continue();
        unexpectedNetwork.push(url.href);
        return route.abort();
      });
      const page = await context.newPage();
      requests = [];
      await page.goto(origin);
      const result = await page.evaluate(scenario => new Promise((resolve, reject) => {
        const worker = new Worker("/nested/voice/bootstrap.js", { type: "module", name: scenario });
        const timer = setTimeout(() => { worker.terminate(); reject(new Error("ORT regression timed out")); }, 60_000);
        worker.onerror = event => { clearTimeout(timer); worker.terminate(); reject(new Error(event.message)); };
        worker.onmessage = ({ data }) => {
          if (data.type === "loaded") worker.postMessage({ id: 1, type: "prepare" });
          else if (data.type !== "status") { clearTimeout(timer); worker.terminate(); resolve(data); }
        };
      }), scenario);
      assert.equal(result.stats.prepared, true, `${scenario}: verified preparation completed before fault injection`);
      assert.equal(result.stats.nativeXhr, 0, `${scenario}: no native XHR fallback`);
      assert.deepEqual(unexpectedNetwork, [], `${scenario}: no non-asset network requests`);
      for (const path of runtime.keys()) assert.equal(requests.filter(request => request === path).length, 1,
        `${scenario}: ${path} downloaded only during explicit preparation, never by fallback`);
      if (scenario === "cached") {
        assert.equal(result.type, "ready", JSON.stringify(result));
        assert.equal(result.stats.ortInit, 0);
        assert.equal(result.stats.instantiations, 1);
        assert.deepEqual(result.stats.instantiatedHashes, [assets.find(asset => asset.path.endsWith(".wasm")).sha256]);
        assert.deepEqual(result.stats.fetchErrors, []);
      } else {
        assert.equal(result.type, "error", JSON.stringify(result));
        assert.match(result.message, /XMLHttpRequest is disabled in the local speech worker/);
        assert.ok(result.stats.fetchErrors.length >= 1, "actual glue attempted guarded fetch");
        for (const error of result.stats.fetchErrors) assert.match(error, scenario === "evicted" ? /Speech pack evicted/ : /Speech asset integrity failed/);
        assert.equal(result.stats.ortInit, null);
        assert.equal(result.stats.instantiations, 0, "no unchecked WASM instantiated");
        assert.deepEqual(result.stats.instantiatedHashes, [], "no unchecked bytes passed to WASM instantiation");
      }
      console.log(`PASS actual ORT ${ortPackage.version}: ${scenario}; native XHR=${result.stats.nativeXhr}, WASM instantiations=${result.stats.instantiations}`);
    } finally { await context.close(); }
  }
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}

// Deliberately no static imports: dependency module evaluation must occur only
// after this boundary is installed. This confines reviewed loaders, not arbitrary JS.
const nativeDownload = globalThis.fetch.bind(globalThis);
let assetFetch: typeof fetch = async () => { throw new Error("TTS assets unavailable"); };
Object.defineProperty(globalThis, "fetch", { value: (input: RequestInfo | URL, init?: RequestInit) => assetFetch(input, init), writable: false, configurable: false });
for (const name of ["XMLHttpRequest", "WebSocket", "EventSource", "Worker", "SharedWorker", "WebTransport", "importScripts"]) {
  Object.defineProperty(globalThis, name, { value: function () { throw new Error("TTS transport denied"); }, writable: false, configurable: false });
}
// A caller can post prepare while dynamic module evaluation is still awaiting.
// Buffer exactly one operation, never text jobs or an unbounded startup queue.
const scope = globalThis as unknown as { onmessage: ((event: MessageEvent) => void) | null };
let first: MessageEvent | undefined;
scope.onmessage = event => {
  if (first) throw new Error("TTS startup busy");
  first = event;
};
// Keep this a separate module URL in the build, not a statically bundled import.
const workerUrl = new URL("./tts-worker.js", import.meta.url).href;
const { startTtsWorker } = await import(/* @vite-ignore */ workerUrl) as typeof import("./tts-worker.js");
startTtsWorker(nativeDownload, fetcher => { assetFetch = fetcher; });
if (first) { const event = first; first = undefined; scope.onmessage?.(event); }
export {};

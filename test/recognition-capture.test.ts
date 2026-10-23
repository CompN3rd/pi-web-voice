import assert from "node:assert/strict";
import test from "node:test";
import { openPcmCapture } from "../src/browser/recognition-capture.ts";

test("openPcmCapture immediately stops a late permission grant after cancellation", async () => {
  const secure = Object.getOwnPropertyDescriptor(globalThis, "isSecureContext");
  const navigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  let grant!: (stream: MediaStream) => void;
  let stops = 0;
  Object.defineProperty(globalThis, "isSecureContext", { value: true, configurable: true });
  Object.defineProperty(globalThis, "navigator", { value: { mediaDevices: { getUserMedia: () => new Promise<MediaStream>(resolve => { grant = resolve; }) } }, configurable: true });
  try {
    const controller = new AbortController();
    const opening = openPcmCapture(controller.signal, () => assert.fail("No PCM after cancel"), () => assert.fail("No stale failure callback"));
    controller.abort();
    grant({ getTracks: () => [{ stop: () => stops++ }] } as unknown as MediaStream);
    await assert.rejects(opening, { name: "AbortError" });
    assert.equal(stops, 1);
  } finally {
    if (secure) Object.defineProperty(globalThis, "isSecureContext", secure); else Reflect.deleteProperty(globalThis, "isSecureContext");
    if (navigator) Object.defineProperty(globalThis, "navigator", navigator); else Reflect.deleteProperty(globalThis, "navigator");
  }
});

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function captureFixture(run: (fixture: ReturnType<typeof fakeCapture>) => Promise<void>) {
  const f = fakeCapture();
  const names = ["isSecureContext", "navigator", "AudioContext", "AudioWorkletNode"] as const;
  const descriptors = names.map(name => Object.getOwnPropertyDescriptor(globalThis, name));
  const values = [true, { mediaDevices: { getUserMedia: async () => f.stream } }, function () { return f.context; }, function () { return f.node; }];
  names.forEach((name, index) => Object.defineProperty(globalThis, name, { value: values[index], configurable: true }));
  try { await run(f); }
  finally { names.forEach((name, index) => {
    if (descriptors[index]) Object.defineProperty(globalThis, name, descriptors[index]!);
    else Reflect.deleteProperty(globalThis, name);
  }); }
}
function fakeCapture() {
  const calls: string[] = [];
  const throws = new Set<string>();
  const invoke = (name: string) => { calls.push(name); if (throws.has(name)) throw new Error(name); };
  const listeners = new Map<number, () => void>();
  const tracks = [0, 1].map(index => ({
    stop: () => invoke(`track${index}.stop`),
    addEventListener: (_name: string, listener: () => void) => listeners.set(index, listener),
    removeEventListener: () => { invoke(`track${index}.remove`); listeners.delete(index); },
  }));
  const node = {
    port: { onmessage: null as ((event: { data: Float32Array }) => void) | null, close: () => invoke("port.close") },
    onprocessorerror: null as (() => void) | null,
    connect() {}, disconnect: () => invoke("node.disconnect"),
  };
  const source = { connect() {}, disconnect: () => invoke("source.disconnect") };
  const context = {
    state: "suspended", destination: {},
    audioWorklet: { addModule: async () => {} },
    createMediaStreamSource: () => source,
    resume: async () => { context.state = "running"; },
    close: async () => { invoke("context.close"); context.state = "closed"; },
  };
  return { calls, throws, listeners, tracks, node, source, context, stream: { getTracks: () => tracks } };
}

test("openPcmCapture stops all tracks synchronously, owns asynchronous graph close and fences late callbacks", async () => {
  await captureFixture(async f => {
    const closing = deferred<void>();
    f.context.close = () => { f.calls.push("context.close"); return closing.promise.then(() => { f.context.state = "closed"; }); };
    let samples = 0, failures = 0;
    const capture = await openPcmCapture(new AbortController().signal, () => { samples++; }, () => { failures++; });
    const lateSample = f.node.port.onmessage!, lateError = f.node.onprocessorerror!;
    const stopping = capture.stop();
    assert.deepEqual(f.calls.slice(0, 2), ["track0.stop", "track1.stop"]);
    assert.ok(stopping instanceof Promise);
    assert.equal(capture.stop(), stopping);
    assert.equal(f.node.port.onmessage, null); assert.equal(f.node.onprocessorerror, null);
    assert.equal(f.listeners.size, 0);
    lateSample({ data: new Float32Array(100) }); lateError();
    assert.equal(samples, 0); assert.equal(failures, 0);
    let settled = false; void stopping.then(() => { settled = true; });
    await Promise.resolve(); assert.equal(settled, false);
    closing.resolve(); await stopping; assert.equal(settled, true);
  });
});

test("openPcmCapture independently attempts all teardown after throwing track/port/node/source cleanup", async () => {
  await captureFixture(async f => {
    const capture = await openPcmCapture(new AbortController().signal, () => {}, () => {});
    for (const name of ["track0.stop", "port.close", "node.disconnect", "source.disconnect"]) f.throws.add(name);
    await assert.rejects(Promise.resolve(capture.stop()), { name: "CaptureTeardownError" });
    for (const name of ["track0.stop", "track1.stop", "track0.remove", "track1.remove", "port.close", "node.disconnect", "source.disconnect", "context.close"]) {
      assert.ok(f.calls.includes(name), name);
    }
    assert.equal(f.node.port.onmessage, null); assert.equal(f.node.onprocessorerror, null);
  });
});

test("openPcmCapture reports rejected and throwing context close as teardown uncertainty", async () => {
  for (const throwing of [true, false]) await captureFixture(async f => {
    const capture = await openPcmCapture(new AbortController().signal, () => {}, () => {});
    f.context.close = () => { if (throwing) throw new Error("close"); return Promise.reject(new Error("close")); };
    await assert.rejects(Promise.resolve(capture.stop()), { name: "CaptureTeardownError" });
    assert.ok(f.calls.includes("track1.stop")); assert.ok(f.calls.includes("source.disconnect"));
  });
});

test("openPcmCapture canceled resume waits for close and late resume before settling open", async () => {
  await captureFixture(async f => {
    const resume = deferred<void>(), closing = deferred<void>();
    f.context.resume = () => resume.promise;
    f.context.close = () => closing.promise.then(() => { f.context.state = "closed"; });
    const controller = new AbortController();
    const opening = openPcmCapture(controller.signal, () => assert.fail(), () => assert.fail());
    await new Promise(resolve => setImmediate(resolve));
    controller.abort(); assert.ok(f.calls.includes("track1.stop"));
    let settled = false;
    const rejected = assert.rejects(opening, { name: "AbortError" }).then(() => { settled = true; });
    closing.resolve(); await Promise.resolve(); assert.equal(settled, false);
    resume.resolve(); await rejected;
  });
});

test("openPcmCapture aborted startup preserves teardown failure instead of reporting safe cancellation", async () => {
  await captureFixture(async f => {
    const resume = deferred<void>(); f.context.resume = () => resume.promise;
    f.context.close = async () => { throw new Error("close"); };
    const controller = new AbortController();
    const opening = openPcmCapture(controller.signal, () => {}, () => {});
    await new Promise(resolve => setImmediate(resolve));
    const rejected = assert.rejects(opening, { name: "CaptureTeardownError" });
    controller.abort(); resume.resolve(); await rejected;
    assert.ok(f.calls.includes("track0.stop")); assert.ok(f.calls.includes("track1.stop"));
  });
});

test("openPcmCapture processing failure starts cleanup once and retains observable close", async () => {
  await captureFixture(async f => {
    let failures = 0;
    const capture = await openPcmCapture(new AbortController().signal, () => {}, () => { failures++; });
    const lateError = f.node.onprocessorerror!;
    lateError(); lateError(); await capture.stop();
    assert.equal(failures, 1);
    assert.equal(f.calls.filter(name => name === "track0.stop").length, 1);
  });
});

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

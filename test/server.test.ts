import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import plugin from "../src/server.ts";
import type { ServerPluginActivationContext, ServerPluginPeerRequestContext, ServerPluginStartContext } from "@jmfederico/pi-web/server-plugin-api";

test("text-only server rejects retired audio transport without network or credentials", async t => {
  const directory = await mkdtemp(join(tmpdir(), "voice-server-"));
  const signal = new AbortController().signal;
  const activation = plugin.activate({ dataDirectory: directory, lifetimeSignal: signal } as ServerPluginActivationContext);
  t.after(async () => { await activation.dispose(); await rm(directory, { recursive: true, force: true }); });
  activation.start({ capabilities: { resolve: () => ({}) } } as unknown as ServerPluginStartContext);
  const request = (operation: string, input = {}) => activation.peer.request({
    operation, input, signal, project: { id: "project" }, workspace: { id: "workspace" },
  } as ServerPluginPeerRequestContext);
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error("Network prohibited"); };
  t.after(() => { globalThis.fetch = originalFetch; });
  await assert.rejects(request("connect", { sdp: "v=0\r\n" }), /Unsupported voice operation/);
  await assert.rejects(request("transcribe", { audio: "not accepted" }), /Unsupported voice operation/);
  assert.deepEqual(await request("list"), []);
  const lease = await request("arm", { count: 1 }) as { token: string; remaining: number };
  assert.equal(lease.remaining, 1);
  assert.equal(typeof lease.token, "string");
  assert.deepEqual(await request("disarm", { token: lease.token }), { ok: true });
  assert.equal(calls, 0);
});

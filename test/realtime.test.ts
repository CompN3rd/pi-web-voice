import test from "node:test";
import assert from "node:assert/strict";
import { exchangeSdp, sessionConfig, VOICE_TOOLS } from "../src/realtime.ts";

test("serialized SDP is bounded after JSON escaping", async t => {
  const old = process.env.OPENAI_API_KEY; process.env.OPENAI_API_KEY = "test";
  t.after(() => { if (old === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = old; });
  const request: typeof fetch = async () => new Response("v=0\r\n" + "a=x\r\n".repeat(9500));
  await assert.rejects(exchangeSdp({ sdp: "v=0\r\n" }, {}, new AbortController().signal, request), /Serialized SDP/);
});
test("config uses native audio and GA semantic VAD schema; no separate STT/TTS", () => {
  const config = sessionConfig({});
  assert.deepEqual(config.output_modalities, ["audio"]);
  assert.equal(config.audio.input.turn_detection.type, "semantic_vad");
  assert.equal(config.audio.input.turn_detection.interrupt_response, true);
  assert.equal(sessionConfig({ turnDetection: "silence" }).audio.input.turn_detection.type, "server_vad");
  assert.throws(() => sessionConfig({ realtimeModel: "https://evil" }));
  assert.throws(() => sessionConfig({ turnDetection: "invalid" }));
  assert.equal(VOICE_TOOLS.some(t => /shell|delete|arm|confirm/.test(t.name)), false);
});
test("SDP exchange holds key server-side, uses fixed endpoint and rejects redirects", async t => {
  const old = process.env.OPENAI_API_KEY; process.env.OPENAI_API_KEY = "test-not-a-real-key";
  t.after(() => { if (old === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = old; });
  let calls = 0;
  const request: typeof fetch = async (url, options) => {
    calls++;
    assert.equal(url, "https://api.openai.com/v1/realtime/calls");
    assert.equal(options?.redirect, "error");
    assert.equal((options?.headers as Record<string, string>).Authorization, "Bearer test-not-a-real-key");
    assert.equal((options?.body as FormData).get("sdp"), "v=0\r\n");
    return new Response("v=0\r\nanswer", { status: 201 });
  };
  const answer = await exchangeSdp({ sdp: "v=0\r\n" }, {}, new AbortController().signal, request);
  assert.equal(answer.sdp, "v=0\r\nanswer"); assert.equal(calls, 1);
});
test("missing credentials/malformed SDP fail before network; provider error body never leaks", async t => {
  const old = process.env.OPENAI_API_KEY; delete process.env.OPENAI_API_KEY;
  t.after(() => { if (old === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = old; });
  let calls = 0;
  const request: typeof fetch = async () => { calls++; return new Response("secret body", { status: 403 }); };
  await assert.rejects(exchangeSdp({ sdp: "v=0\r\n" }, {}, new AbortController().signal, request), /OPENAI_API_KEY/);
  process.env.OPENAI_API_KEY = "test";
  await assert.rejects(exchangeSdp({ sdp: "not-sdp" }, {}, new AbortController().signal, request), /Invalid SDP/);
  assert.equal(calls, 0);
  await assert.rejects(exchangeSdp({ sdp: "v=0\r\n" }, {}, new AbortController().signal, request), error => /HTTP 403/.test(String(error)) && !String(error).includes("secret body"));
});

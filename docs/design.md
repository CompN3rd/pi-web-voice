# Browser-local voice design

## Decision

The owner requires **no separately billed audio service** and targets a **Google Pixel 8 running the browser**. “Local” means that phone, not the Pi Web server. The original OpenAI Realtime design is retired: no Realtime endpoint, API key, WebRTC provider session, or cloud speech fallback remains in the intended architecture.

Speech is an input/output adapter for ordinary Pi text workers. It is not another autonomous agent and does not interpret results as commands.

```text
Phone microphone → bounded memory-only PCM → browser worker / local Whisper
                                                       ↓
                                      editable transcript + exact target
                                                       ↓
                                          explicit instruction approval
                                                       ↓
Pi Web public package peer → durable admission ledger → ordinary Pi worker
                                                       ↓
Phone text display ← bounded result/question ← companion settlement
       ↓ explicit playback
Browser/OS voice marked local → phone speaker
```

The phone downloads application/runtime/model assets from the deployment. Approved task text goes to Pi Web and the worker's configured provider. Audio does not go to the Pi Web backend or an inference service. Local speech does **not** make text workers offline or change their provider billing/limits.

## Recognition

Use `@huggingface/transformers@3.8.1` and quantized `onnx-community/whisper-tiny.en` in a dedicated Web Worker, with the matching ONNX runtime assets. WASM single-thread inference avoids assuming cross-origin isolation or Android WebGPU compatibility. English is the first supported language; do not label this multilingual.

- Self-host fixed model/runtime assets; no CDN imports or browser remote-model fallback.
- Explicit preparation before microphone activation, with visible download/loading state.
- Bounded push-to-talk/explicit end-utterance capture; actual sample-rate conversion to mono 16 kHz float PCM.
- Release microphone tracks before inference; cancel/hide/context change discards pending audio/results.
- No raw audio storage, upload, or diagnostic recording.
- Silence filtering reduces—not eliminates—Whisper hallucinations. Every transcript is editable and requires explicit approval before dispatch.
- Missing assets, initialization failures, memory pressure, or unsupported browser capability leave text input available. They must not switch to cloud recognition.
- The dedicated worker denies XMLHttpRequest, including ONNX Runtime's synchronous fallback; verified cache-only fetch must not be bypassed on loading errors.

The q8 encoder and merged decoder weights total approximately 40.84 MB, excluding tokenizer, runtime, JavaScript and cache overhead. This is not a RAM estimate. Pixel 8 inference time, heat, battery and memory behavior are unmeasured.

Native `SpeechRecognition` is deliberately not used: desktop support for `processLocally` does not establish Android support, and ordinary browser recognition may use remote processing. Ollama is not required; it is a model server, not a phone-browser runtime.

## Playback

Only explicitly selected English voices reporting `localService === true` are eligible. Re-resolve locality before every playback; never fall back to an unspecified/default or remote voice. No suitable voice means text-only output. Capture and playback are half-duplex: starting capture cancels playback. Stop speaking only cancels speech, not workers.

`localService` is a browser/OS assertion, not network attestation. Android's TTS engine may have behavior outside browser network interception. Actual Pixel airplane-mode playback and device-level traffic checks remain mandatory before claiming verified offline speech.

## Authority and interaction

Recognition produces **text**, not tool calls. The UI explicitly selects a new task or an exact worker/revision for a follow-up. No free-form intent model, spoken “yes” authorization, wake word, or automatic hands-free dispatch is part of this redesign. Review the exact transcript, target and model before admitting a command.

Preserve the existing `Command`, `Worker`, receipt and ledger contracts:

- Persist admission before session creation; session identity before initial prompt delivery.
- Same request ID/payload deduplicates; conflicting payload rejects.
- Never retry uncertain session creation or prompt delivery automatically.
- Exact workspace/session IDs, revisions and monotonic companion sequences fence follow-ups.
- Uncertain observation becomes `unknown`, not failed or safe to retry.
- `completed` means a settled final agent response, not independently verified task success.
- Closing voice never cancels published workers.
- Core `ask_user` and other generic Pi permission dialogs still require the conversation UI. Only `voice_request_input` is bridged.

Panel context generation and permission epochs must fence preparation, recording, inference, result reads, approval issuance and playback. Context changes discard old drafts/transcripts/targets and revoke old-context allowances. Audio modules have no backend dispatch authority.

The text backend retains its existing scoped allowance protocol for compatibility; the redesigned UI uses exact per-instruction approval, not automatic transcription dispatch.

## Packaging and compatibility

Retain public browser API 4 / server API 3 for Pi Web `1.202610.3`, and companion `1.2.0`. Do not use private session routes, provider credential stores or API5 examples. Keep the package private and disabled by default. Model provisioning is an explicit developer/operator step, not an install lifecycle hook. Worker/worklet JavaScript resolves relative to the plugin's served browser directory. The pinned host limits the entire plugin artifact to 16 MiB, so the approximately 65 MB model/runtime pack is served separately at the explicit same-origin static path `/pi-voice-speech/`. This path must be configured by the deployment operator; it is not a host API or private route. Do not place pack assets inside the plugin root. See `deployment.md`.

Converted-model license labels differ across upstream/model cards; retain provenance and license notices and resolve redistribution requirements before release. A local build/prototype is not release approval.

## Device acceptance and future work

First validate the real-host asset URLs/CSP and the Pixel 8 foreground workflow over authenticated HTTPS. Test short English commands, silence, noise, long utterances, cancellation, memory pressure, cache eviction, permission denial, headset routing and screen locking. No background/locked-screen/driving guarantee is made.

Only after basic acceptance consider WebGPU acceleration, multilingual packs, a fully bundled local TTS model, conversational routing or wake-word processing. Durable notifications, safe retention tooling and explicit worker control remain separate reliability milestones. Do not expand scope into a native app or paid provider without owner approval.

## Research sources

- [Transformers.js WebGPU and Whisper examples](https://huggingface.co/docs/transformers.js/guides/webgpu)
- [Transformers.js environment controls](https://huggingface.co/docs/transformers.js/api/env)
- [Pinned Transformers.js package](https://registry.npmjs.org/@huggingface/transformers/3.8.1)
- [ONNX Runtime Web flags and asset matching](https://onnxruntime.ai/docs/tutorials/web/env-flags-and-session-options.html)
- [Whisper tiny.en converted model files](https://huggingface.co/onnx-community/whisper-tiny.en/tree/main)
- [MDN SpeechRecognition compatibility data](https://github.com/mdn/browser-compat-data/blob/main/api/SpeechRecognition.json)
- [MDN localService](https://developer.mozilla.org/en-US/docs/Web/API/SpeechSynthesisVoice/localService)

Sources establish API candidates, not measured Pixel performance. See `validation.md` for executed checks and remaining gates.

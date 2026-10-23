# Browser-local voice design

## Decision

**Implemented playback decision:** English-only Whisper tiny.en recognition and Kokoro `af_heart` synthesis run in separate browser workers. OS `speechSynthesis` and remote/system/alternate-voice fallbacks are removed. Exact inventory/runtime pins and automated loader/controller checks are recorded in [qualification](tts-qualification.md); full-model TTS, Pixel and live-host acceptance remain unrun. [ADR 0002](adr/0002-browser-model-tts.md) remains the delivery contract, including unresolved license gates.

The owner requires **no separately billed audio service** and targets a **Google Pixel 8 running the browser**. “Local” means that phone, not the Pi Web server. The original OpenAI Realtime design is retired: no Realtime endpoint, API key, WebRTC provider session, or cloud recognition fallback remains in the intended architecture.

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
Kokoro worker → bounded mono 24 kHz PCM → owned Web Audio → phone speaker
```

The phone loads application code from Pi Web and acquires speech assets through verified cache, explicit pinned public downloads or local file import; see [ADR 0001](adr/0001-browser-owned-speech-pack-acquisition.md). Approved task text goes to Pi Web and the worker's configured provider. Audio does not go to the Pi Web backend or an inference service. Local speech does **not** make text workers offline or change their provider billing/limits.

## Recognition

Use `@huggingface/transformers@3.8.1` and quantized `onnx-community/whisper-tiny.en` in a dedicated Web Worker, with the matching ONNX runtime assets. WASM single-thread inference avoids assuming cross-origin isolation or Android WebGPU compatibility. English is the first supported language; do not label this multilingual.

- Explicitly download pinned model/runtime files or import a matching local pack. Never directly execute unchecked CDN imports; verify bytes before blob-module loading. No remote inference fallback.
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

The adapter uses the project's pinned Transformers.js public `StyleTextToSpeech2Model`, `AutoTokenizer` and `Tensor` APIs, not upstream Kokoro voice-download/cache or truncating generation helpers. Only quantized Kokoro and verified `af_heart` voice bytes at normal speed are allowed. Guarded bootstrap installs transport restrictions before dependency evaluation; initialization/inference read only verified compiled assets. The phonemizer also executes in the worker. No alternate engine is selected on failure.

Separate explicit acquisition/preparation, English Heart enablement and Speak controls are required; preparation is silent. Speak resumes an owned Web Audio context from the user gesture before awaiting synthesis. Playback shows the exact selected prefix (at most 1,000 UTF-16 code units, without splitting surrogate pairs), plans bounded chunks against the actual tokenizer budget without truncation, and conservatively rejects unsupported text rather than silently dropping it. Full text remains available. English-only is not a language-detection or pronunciation guarantee. PCM is transient, mono 24 kHz, with bounded chunks, queue and job duration; no generated recordings are saved.

A document-level speech coordinator allows one heavyweight speech runtime at a time and controls pack-specific cache clearing. Preparing one pack releases the other's idle runtime and resets its readiness, without clearing typed drafts, workers or cached assets. TTS cannot prepare during recording/transcription. Stop speaking cancels TTS preparation/synthesis/playback and releases its worker/weights; it requires explicit reprepare but does not revoke instruction approvals or stop coding workers. Full off, hide/pagehide and context/target/model changes revoke broader permissions; stale source/revision invalidation discards affected work. Returning to visibility never resumes audio.

Capture tracks stop synchronously; asynchronous capture-context close/resume settlement remains owned until safe completion. Playback teardown likewise retains ownership until settled. Audio stays blocked during teardown. Failure or the five-second deadline latches audio unsafe across controller recreation and panel remounts until document reload. Cleanup attempts independent resources even after a failure. This controls plugin audio in one document, not other tabs or unrelated host audio.

Separate file-picker tickets fence each pack's import; picker-induced hide preserves at most a selection ticket, never audio/permission authority. Clear-this-pack first cancels selected resident use under a coordinator reservation, then removes only its exact compiled cache identity. It preserves the other pack, host data, old cache revisions and safety latches; another tab's verified in-memory weights are not canceled.

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

Retain public browser API 4 / server API 3 for Pi Web `1.202610.3`, and companion `1.2.0`. Do not use private session routes, provider credential stores or API5 examples. Keep the package private and disabled by default. Worker/worklet JavaScript resolves relative to the plugin's served browser directory. The pinned host limits the entire plugin artifact to 16 MiB, so the approximately 65 MB recognition and 116 MB TTS packs are acquired separately by the browser, through explicit pinned download or verified file import. No custom host route or reverse-proxy mapping is required. Developer provisioning/export is optional and never an install lifecycle hook. Synthetic runtime cache URLs are internal keys only, not fetched routes. Keep large source/export files outside installed plugin roots. See `deployment.md` and ADR 0001.

The build is approximately 4.72 MB uncompressed, including two Transformers worker bundles but excluding external packs. Converted-model/voice provenance and embedded eSpeak native corresponding-source and combined GPL obligations remain release/conveyance blockers. Retain notices; neither a successful build nor `private: true` is license clearance.

## Device acceptance and future work

First validate the real-host asset URLs/CSP and the Pixel 8 foreground workflow over authenticated HTTPS. Test short English commands, silence, noise, long utterances, cancellation, memory pressure, cache eviction, permission denial, headset routing and screen locking. No background/locked-screen/driving guarantee is made.

Browser-model TTS is implemented under ADR 0002 but is not model/device-qualified; acquire its verified assets separately rather than bundling large weights into the plugin. Only after basic acceptance consider WebGPU acceleration, multilingual packs, conversational routing or wake-word processing. Durable notifications, safe retention tooling and explicit worker control remain separate reliability milestones. Do not expand scope into a native app or paid provider without owner approval.

## Research sources

- [Transformers.js WebGPU and Whisper examples](https://huggingface.co/docs/transformers.js/guides/webgpu)
- [Transformers.js environment controls](https://huggingface.co/docs/transformers.js/api/env)
- [Pinned Transformers.js package](https://registry.npmjs.org/@huggingface/transformers/3.8.1)
- [ONNX Runtime Web flags and asset matching](https://onnxruntime.ai/docs/tutorials/web/env-flags-and-session-options.html)
- [Whisper tiny.en converted model files](https://huggingface.co/onnx-community/whisper-tiny.en/tree/main)
- [MDN SpeechRecognition compatibility data](https://github.com/mdn/browser-compat-data/blob/main/api/SpeechRecognition.json)

Sources establish API candidates, not measured Pixel performance. See `validation.md` for executed checks and remaining gates.

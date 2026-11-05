# Browser-local voice design

## Product direction

The [guiding vision](vision.md) is Claude Voice Mode–level interaction fidelity using open-source speech models on browser-host hardware, growing into vocal orchestration across project/workspace sessions and potentially Pi Web's first-party multi-machine federation. This document describes the current bounded implementation, not the ceiling of that ambition. Cross-project routing and federation remain future capabilities requiring separate design and validation.

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

## Foreground voice desk and capability boundary

This iteration turns the speech form into a bounded orchestration surface without adding an intent agent or widening dispatch authority. The route and microphone state lead a compact composer, followed by worker attention and deliberate playback. Pack download/import, storage inspection and diagnostics are progressive disclosures rather than the primary interaction. Controls retain keyboard access, visible focus and phone-width wrapping; intentional Review actions focus a heading rather than forcing the phone keyboard. Background polling never steals focus.

Capability inspection used the installed `@jmfederico/pi-web@1.202610.3` public API4/API3 declarations and `docs/plugins.md`. API4 supplies selected machine/workspace identity, package-paired peer requests, exact-session navigation and optional read-only project discovery. API3 supplies host-resolved peer scope, visible session creation and connections to already-hosted companions. Paired channels are available, but adding a second transport is unnecessary for this bounded metadata inbox. Existing five-second foreground polling and opt-in reads suffice; no private routes, catalog assumptions or host changes are introduced. Discovery is not cross-project authority. Neither federation management nor cross-project dispatch is authorized here.

### Interaction and attention state

- Recording adds another utterance to the current draft, up to the existing 16,000-character instruction bound; overflow keeps the old draft and reports the error. Full off, hide and context/target/model/revision invalidation still discard drafts and revoke authority. An empty title deterministically uses the first 60 UTF-16 units of normalized instruction text without splitting a surrogate pair. The exact title is visible before approval and can be overridden.
- Optional pause ending uses only local 20 ms energy frames: at least 300 ms of activity above the existing energy threshold, followed by 1.2 seconds of quiet. It invokes the same capture teardown/transcription path as Finish and the 20-second bound. Default remains manual Finish. There is no automatic microphone restart, speech classification, permission grant or dispatch. Real-device threshold suitability is unqualified.
- Attention is derived from current metadata: unseen `needs-input`, `unknown`, `failed`, then `completed` revisions precede reviewed and active work. Counts distinguish pending questions from the three active/uncertain admission slots. `completed` is presented as Result ready, never verified success.
- Review and reply fetches bounded full detail, checks source identity/revision and binds the exact fresh worker/revision before presenting the question in the composer. It clears prior draft/audio authority like a target change. Replies never route by title or ordinal. A newer detail read reconciles metadata and invalidates stale audio/drafts immediately; late older list snapshots cannot roll a known revision backward.
- Reviewed revisions live only in panel memory and clear on context change/remount. They are UI bookkeeping, not durable notification acknowledgements or answers. Polling does not read full text, speak, change the chosen target to another worker, or dispatch. A lost refresh labels the last snapshot stale; visibility return performs only a read refresh, never audio resumption.
- Exact proposals are consumed before async approval. The latest local receipt distinguishes admission from uncertain delivery, keeps the request/worker identity and exact attempted text, and offers no replay action. Receipt display is not a second ledger; durable backend receipts, hashes and capacity rules remain authoritative.
- Spoken briefings are deterministic metadata, prioritized by attention, with the workspace and a worker number/title. Numbers reflect the unchanged ledger insertion order and are display aids only. Detail playback includes the same introduction and status before question/result text. The visible prefix includes the introduction within the 1,000-unit limit. An active status preview remains the captured playback text even when reviewed badges change. Unsupported introductions or content fail closed through the existing TTS validator. No worker text is interpreted as control instructions or summarized by a paid model.

## Recognition

Use `@huggingface/transformers@3.8.1` and quantized `onnx-community/whisper-tiny.en` in a dedicated Web Worker, with the matching ONNX runtime assets. WASM single-thread inference avoids assuming cross-origin isolation or Android WebGPU compatibility. English is the first supported language; do not label this multilingual.

- Explicitly download pinned model/runtime files or import a matching local pack. Never directly execute unchecked CDN imports; verify bytes before blob-module loading. No remote inference fallback.
- Explicit preparation before microphone activation, with visible download/loading state.
- Bounded tap-to-record capture with explicit Finish or optional local pause ending; actual sample-rate conversion to mono 16 kHz float PCM.
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
- Uncertain observation becomes `unknown`, not failed or safe to retry. A post-admission companion exception around prompt delivery likewise retains its receipt and becomes `unknown`, whether the host throws before or after accepting delivery. Discarded turn tracking prevents late lifecycle output from settling it; fresh follow-ups reject.
- `completed` means a settled final agent response, not independently verified task success.
- Closing voice never cancels published workers.
- Core `ask_user` and other generic Pi permission dialogs still require the conversation UI. Only `voice_request_input` is bridged.

Panel context generation and permission epochs must fence preparation, recording, inference, result reads, approval issuance and playback. Context changes discard old drafts/transcripts/targets and revoke old-context allowances. Audio modules have no backend dispatch authority.

The text backend retains its existing scoped allowance protocol for compatibility; the redesigned UI uses exact per-instruction approval, not automatic transcription dispatch.

## Packaging and compatibility

Retain public browser API 4 / server API 3 for Pi Web `1.202610.3`, and companion `1.2.0`. Do not use private session routes, provider credential stores or API5 examples. Keep the package private and disabled by default. Worker/worklet JavaScript resolves relative to the plugin's served browser directory. The pinned host limits the entire plugin artifact to 16 MiB, so the approximately 65 MB recognition and 116 MB TTS packs are acquired separately by the browser, through explicit pinned recognition download or verified file import. TTS is import-only until an approved source-aware distribution URL exists; old phonemizer packs are not reused. No custom host route or reverse-proxy mapping is required. Developer provisioning/export is optional and never an install lifecycle hook. Synthetic runtime cache URLs are internal keys only, not fetched routes. Keep large source/export files outside installed plugin roots. See `deployment.md` and ADR 0001.

The build is approximately 5.50 MB uncompressed, including two Transformers worker bundles but excluding external packs. Converted-model/voice provenance and complete combined-source/dependency native-source and GPL obligations remain release/conveyance blockers; the eSpeak engine now has a traced source-built replacement. Retain notices; neither a successful build nor `private: true` is license clearance.

## Device acceptance and future work

First validate the real-host asset URLs/CSP and the Pixel 8 foreground workflow over authenticated HTTPS. Test short English commands, silence, noise, long utterances, cancellation, memory pressure, cache eviction, permission denial, headset routing and screen locking. No background/locked-screen/driving guarantee is made.

Browser-model TTS is implemented under ADR 0002 but is not model/device-qualified; acquire its verified assets separately rather than bundling large weights into the plugin. Only after basic acceptance consider WebGPU acceleration, multilingual packs, conversational routing or wake-word processing. This desk improves explicit foreground orchestration; it does not claim Claude Voice Mode latency or natural-language intent control. Durable notifications, safe retention tooling and explicit worker control remain separate reliability milestones. Do not expand scope into a native app or paid provider without owner approval.

## Research sources

- [Transformers.js WebGPU and Whisper examples](https://huggingface.co/docs/transformers.js/guides/webgpu)
- [Transformers.js environment controls](https://huggingface.co/docs/transformers.js/api/env)
- [Pinned Transformers.js package](https://registry.npmjs.org/@huggingface/transformers/3.8.1)
- [ONNX Runtime Web flags and asset matching](https://onnxruntime.ai/docs/tutorials/web/env-flags-and-session-options.html)
- [Whisper tiny.en converted model files](https://huggingface.co/onnx-community/whisper-tiny.en/tree/main)
- [MDN SpeechRecognition compatibility data](https://github.com/mdn/browser-compat-data/blob/main/api/SpeechRecognition.json)

Sources establish API candidates, not measured Pixel performance. See `validation.md` for executed checks and remaining gates.

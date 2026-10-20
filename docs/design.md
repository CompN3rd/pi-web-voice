# Research and design decisions

Research performed 2026-10-20 using official provider/browser documentation, upstream project READMEs, the installed Pi/Pi Web declarations, and sibling plugin examples. Sources describe APIs; they do not establish this account's model access, measured latency, mobile reliability or production readiness.

## Recommendation in one paragraph

Use a **separate audio conversation controller** with OpenAI Realtime/WebRTC first; it delegates ordinary text instructions to visible Pi Web worker sessions, which can use any available Pi text model. Let semantic VAD decide when a sentence is finished, with a configurable silence-based fallback. Start with one explicit activation tap and a bounded interaction window, not an unreliable imitation of an OS wake assistant. Add local wake-word processing only after device/echo/false-trigger testing. If guaranteed locked-screen use is mandatory, build a native mobile client with appropriate OS audio/background support; a PWA or generic WebView wrapper is not a demonstrated substitute.

## 1. Native audio providers

### OpenAI Realtime: chosen first adapter

Official [WebRTC guide](https://developers.openai.com/api/docs/guides/realtime-webrtc) recommends WebRTC for browser voice: microphone and generated speech travel as media tracks, while `oai-events` carries JSON control/tool events. This avoids hand-writing PCM conversion, packet scheduling and playback queues in the browser.

The implemented flow is the documented **unified interface**:

1. A user gesture obtains microphone permission.
2. Browser creates an SDP offer and sends it through Pi Web's authenticated-by-deployment, machine/workspace-bound package peer.
3. Plugin backend posts multipart `sdp` and `session` to `https://api.openai.com/v1/realtime/calls` with its server-only API key.
4. Browser applies the returned SDP answer. Media then flows directly between browser and OpenAI, not as encoded JSON through Pi Web.

The [alternative ephemeral-token flow](https://developers.openai.com/api/docs/guides/realtime-webrtc) is also viable, but unnecessary for this initial paired-server implementation. Either way, do not put a standard key in browser settings/localStorage. The retrieved Realtime examples name `gpt-realtime-2.1`; availability and billing are account-specific, so this is a configurable setting rather than a claimed universal model choice.

**Native audio does not mean offline.** OpenAI receives captured audio and the bounded tool outputs explicitly supplied to that voice session. The architecture removes an extra STT vendor and extra TTS vendor, not the chosen model provider. It also does not treat a ChatGPT/Codex subscription as a Realtime API entitlement.

Current documentation has both **GPT-Live** and **Realtime** sections. Their session endpoints/events differ. This prototype implements Realtime only; do not substitute `/v1/live/sessions`, `session.started` or GPT-Live model names without a separate adapter.

Sources: [Realtime conversations/function calling](https://developers.openai.com/api/docs/guides/realtime-conversations), [server-side controls](https://developers.openai.com/api/docs/guides/realtime-server-controls), [Agents JS](https://github.com/openai/openai-agents-js).

### Gemini Live: credible second adapter

[Gemini Live](https://ai.google.dev/gemini-api/docs/live) supports native audio conversations, tool calls, interruption and ephemeral authentication. It is not a drop-in WebRTC endpoint: direct integration uses WebSockets with PCM capture/resampling and output-buffer management. The [capabilities guide](https://ai.google.dev/gemini-api/docs/live-guide) specifies 16-bit PCM, nominal 16 kHz input and 24 kHz output; model/session-resumption details evolve. [Ephemeral-token validity](https://ai.google.dev/gemini-api/docs/live-api/ephemeral-tokens), connection duration and context limits are distinct clocks.

Recommendation: keep provider transport behind an adapter seam, but do not build a misleading generic STT/TTS abstraction. Gemini needs its own audio worklets, resampling, playout/interruption accounting, authentication and reconnection tests. Only OpenAI is implemented now.

## 2. Trigger word versus silence versus end word

These are **different decisions**:

| Mechanism | Question it answers | Recommendation |
| --- | --- | --- |
| Wake phrase | Should ambient speech activate a conversation? | Future local detector, not a cloud prompt instruction |
| VAD | Is a person speaking? | Provider VAD during an explicitly active connection |
| Semantic turn detection | Has the person finished their thought? | Default low-eagerness semantic VAD; better fit for pauses while thinking |
| Silence timer | Has sound stopped for N milliseconds? | Optional predictable fallback; initial setting 1000 ms, not measured as optimal |
| Explicit “over/send” word | Does the person want to end a turn now? | Optional later mode for long dictated tasks, not default conversational ergonomics |
| Push-to-talk | Is this utterance intentionally addressed to the agent? | Useful future hardware/headset fallback; manual activation/mute is implemented now |

[OpenAI VAD](https://developers.openai.com/api/docs/guides/realtime-vad) distinguishes `server_vad` from `semantic_vad`. Current configuration belongs under `session.audio.input.turn_detection`; old beta top-level examples are not copied. `create_response` and `interrupt_response` control automatic replies and interruption separately.

A fixed short silence timeout can cut off “please change … [thinking pause] … just the test.” A long timeout makes every command feel sluggish. Semantic VAD is therefore the initial preference, but noisy car behavior, language, accents, music and echo must be measured. No latency/accuracy benchmark was performed.

### Proposed eventual interaction state machine

`OFF → LOCAL-ARMED → ACTIVE-LISTENING ↔ SPEAKING → LOCAL-ARMED → OFF`

- **OFF:** no microphone tracks.
- **LOCAL-ARMED (not implemented):** microphone analyzed locally for a wake phrase; **captured audio is not sent upstream**. A short memory-only pre-roll can avoid clipping a first syllable. No cloud STT needed.
- **ACTIVE:** wake acknowledgement/chime, bounded listening window, semantic turn-taking. Say a pause phrase to return to local-armed mode, or stop to release the mic entirely.
- **SPEAKING:** user speech can interrupt playback, but never implicitly cancels a coding worker.

The current prototype deliberately has `OFF → ACTIVE ↔ MUTED → OFF`, with no local-armed state. “Go quiet” disables captured-audio transmission and revokes instruction allowance; a tap resumes. A prompt telling a cloud model to ignore everything until “Hey Pi” is **not a privacy-preserving wake gate**: the audio has already left the device.

Potential local detectors: [openWakeWord](https://github.com/dscripka/openWakeWord) and [Porcupine Web](https://picovoice.ai/docs/api/porcupine-web/). Porcupine documents a Web SDK and AccessKey requirement; license/network behavior needs review. openWakeWord is a useful open-source candidate, but browser/WASM deployment quality is not established by its Python/server examples. Neither is selected or bundled here.

Wake phrases are not speaker authentication. Another passenger, a podcast, the assistant's speaker output or adversarial audio can trigger them. Therefore neither a wake word nor model-interpreted “yes” should grant irreversible authority by itself.

## 3. Worker sessions and feedback

### Architecture

```text
Browser microphone ── WebRTC audio ── OpenAI Realtime ── WebRTC speech ── speaker
                                      │ tool intent / tool result
Browser allowlisted tool router ── Pi Web package peer (fixed workspace)
                                      │
                            Plugin durable admission ledger
                                      │ exact session ID
                      public pi-sessions + pi-session-events capabilities
                                      │
                           Native companion in normal Pi session
                                      │ text prompt / normal Pi tools
                     any available Pi provider/model (no audio required)
```

The audio controller does not own a shell or filesystem tool. It can propose/start a scoped task, propose/reply to an idle worker, list metadata, read a bounded result, or mute its own microphone. The text worker still has normal Pi tools and permissions; this is separation of protocols, **not sandboxing**.

### Durable state and truthful statuses

Each worker has a UUID, exact project/workspace/session IDs, title, actual model, timestamps, status, revision, companion sequence, result and optional question. Each mutating instruction has its own UUID and payload hash. The ledger persists admission before creation, session identity before kickoff, and never retries uncertain side effects automatically.

- `starting`: durable admission; session creation or prompt delivery still pending.
- `running`: companion accepted the text task; a 15-second start watchdog bounds unobserved delivery.
- `needs-input`: this companion's question tool saved a question and the turn settled.
- `completed`: successful final text at **agent_settled**, not at `agent_end` or mere transport receipt. This is not independent task verification.
- `failed`: observable failed/aborted agent outcome, not inference from silence.
- `unknown`: tracking, delivery or conversational attribution uncertain; inspect the exact conversation.

Snapshot ordering is monotonic across session branch changes. Rewinding/interfering with a worker invalidates attribution; follow-ups must match both the backend revision and the current companion sequence/status immediately before delivery. Idle alone is not permission to reply to a stale conversation.

Browser loss does not cancel published worker sessions. The backend and companion retain results; reopening a saved session can make its companion available again. A crash between host publication and ledger identity save cannot be made exactly-once without an upstream transactional/idempotent create API. Such cases remain unknown and require inspection.

### Notifications and questions

Current implementation polls while mounted and announces state changes while connected, waiting for a gap in speech. Read results on request rather than automatically streaming code/tool logs to the audio provider. Alerts include only IDs/status, not untrusted result instructions. Thinking and raw tool outputs are never exported by the companion.

The next delivery milestone should add a durable **notification inbox** with per-user/per-device acknowledgements, replay after reconnection, de-duplication, quiet/urgent policies and a “give me the summary since I was away” command. The current ledger is durable, but spoken-notification delivery is not exactly-once or durable.

Pi has several distinct question mechanisms. Only the new `voice_request_input` tool is bridged. Core `ask_user`, generic `ctx.ui` permission dialogs and unstructured prose are not silently intercepted. A future public host question capability should expose exact question IDs/revisions, typed options, expiry, and first-answer-wins semantics. Until then, direct the user to the conversation instead of guessing answers or treating steering as a dialog response.

## 4. Existing work worth reusing

| Project | Relevance | Why not simply install it for this request? |
| --- | --- | --- |
| [iurysza/pi-voice](https://github.com/iurysza/pi-voice) | Closest precedent: OpenAI Realtime conversational layer delegates to regular Pi models | Terminal/macOS/Linux and SoX media path; README notes no acoustic echo cancellation; not this Pi Web browser plugin |
| [yukukotani/pi-voice](https://github.com/yukukotani/pi-voice) | Voice daemon/push-to-talk and varied speech-provider choices | Different STT/TTS pipeline and integration surface |
| [OpenAI Realtime Console](https://github.com/openai/openai-realtime-console/) | Browser WebRTC/data-channel reference | Demo transport, not Pi worker lifecycle/authority/durability |
| [OpenAI Agents JS](https://github.com/openai/openai-agents-js) | Higher-level voice agent tooling | Useful optional transport framework; does not replace the Pi session integration |
| Pi Web Captain's Log / Workspace Reviews | Native companion/session event bridge and saved results | Text demo, no microphone/audio control |
| Sibling Automations / Subagents / Research Library | Existing exact-model, correlated receipt, panel and durable-state conventions | Separate products; do not import their private stores or confuse pi-subagents runs with Pi Web sessions |

This search found relevant precedents, **not proof that no other Pi Web voice plugin exists**. No third-party implementation was installed or performance-tested. These links are research references, not copied source or an endorsement.

## 5. Browser and in-car boundary

[Microphone access](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia) requires a secure context and permission. A phone visiting `http://192.168.x.x` is not accessing its own localhost, so the desktop localhost exception does not help. Use HTTPS over a trusted private/VPN deployment. [Autoplay policy](https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Autoplay) can require an explicit gesture; retain working playback controls and handle refusal.

[Screen Wake Lock](https://developer.mozilla.org/en-US/docs/Web/API/Screen_Wake_Lock_API) can keep a visible screen awake, but it can be revoked and cannot override device locking or grant background recording. [Page lifecycle behavior](https://developer.chrome.com/docs/web-platform/page-lifecycle-api) can freeze/discard hidden pages. [Historical WebKit issue 241400](https://bugs.webkit.org/show_bug.cgi?id=241400) illustrates microphone/lock issues, but is not a universal claim about current Safari.

For this reason, hiding the current panel disconnects audio explicitly. Device/network/Bluetooth/head-unit behavior must be tested on real hardware. A browser-only prototype cannot honestly be described as dependable hands-free car infrastructure. Use should not require reading screens, debugging permissions or confirming dangerous actions while driving; pull over for those activities.

## 6. Staged roadmap

1. **Delivered local prototype:** one scoped workspace, OpenAI native audio, ordinary text workers, conservative approvals, tests and research. Activation still pending.
2. **Real-host/provider acceptance:** isolated Pi Web profile, actual companion discovery, one harmless text task, actual Realtime call, SDP/autoplay/VAD/barge-in tests, usage/cost accounting.
3. **Reliability:** durable notification inbox, explicit worker timeout/cancel controls with ownership checks, better short spoken handles, retention UI and crash-window recovery tooling.
4. **Cross-project control:** public v5 catalogs and machine/project-scoped backend; exact target disambiguation and per-target grants. No private route adapter hidden in the plugin.
5. **Wake gate:** local browser inference, privacy traffic tests, false-accept/reject rates, echo/music/passenger/battery testing, headset fallback.
6. **Native mobile if required:** OS-supported background audio and physical/Bluetooth controls; reuse the backend text-worker protocol.
7. **Second audio provider:** Gemini Live adapter with native PCM/worklet tests, separate authentication/lifecycle behavior.

Do not parallelize these into a claim of production support before the earlier acceptance gates pass.

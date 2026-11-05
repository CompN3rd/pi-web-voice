# Pi Web Voice

> **ADR 0002 implemented; qualification is incomplete.** English Whisper recognition and Kokoro `af_heart` synthesis execute in browser workers. OS `speechSynthesis` and cloud/system/alternate-voice fallbacks are removed. Acquisition, preparation, playback enablement and Speak are explicit actions. Full-model TTS, Pixel and isolated-host acceptance remain **unrun**; complete combined-source/dependency delivery and GPL obligations still block release/conveyance. The former opaque phonemizer has been replaced by a reproducible source-built engine. See [ADR 0002](docs/adr/0002-browser-model-tts.md) and [qualification](docs/tts-qualification.md).

Experimental **browser-local voice desk** for `@jmfederico/pi-web`. Talk through a task, approve the exact instruction, and manage concurrent workers through a workspace attention inbox. Read or locally hear results and saved questions, then reply to the exact worker without carrying context between conversations.

**Target device: Google Pixel 8. Real-device acceptance is not yet performed.** Speech recognition and synthesis run on the device running the browser, not the Pi Web server. There is no OpenAI Realtime API, separately billed speech service or remote speech fallback. Ordinary text workers still use their configured Pi provider/authentication and its usage limits/costs.

The source repository is public; the npm package remains private, experimental, and not driving-validated. Local installation and server activation are explicit operator steps; repository validation alone does not establish live-host acceptance. See [design](docs/design.md), [security](docs/security.md), and [validation](docs/validation.md).

## Guiding star

Reach Claude Voice Mode–level vocal interaction fidelity in Pi Web, using open-source speech models on the browser device. Go beyond a single conversation: become a vocal orchestration plane for delegating across projects/workspace sessions, hearing feedback and answering workers that need input, with eventual exploration of Pi Web's first-party multi-machine federation.

This is the long-term goal, not current capability. See [the product vision](docs/vision.md); the prototype's present scope and safety limits remain below.

## Architecture

```text
Phone mic → local Whisper worker → editable transcript → exact approval
                                                              ↓
                         Pi Web → ordinary Pi text worker / existing auth
                                                              ↓
Phone speaker ← Web Audio PCM ← local Kokoro worker ← result / saved question
```

- English-only quantized Whisper tiny.en is the initial recognition model, using a browser WASM worker. No Ollama server is needed.
- Speech assets are acquired explicitly by the browser: verified cache or local `.pivoice` file import; recognition additionally supports pinned public download. No additional host route or inference service is required. Downloads need bandwidth/storage; local computation uses phone battery/memory.
- Separately prepare the pinned Kokoro TTS pack, enable English Heart playback, then tap Speak. Only `af_heart` at normal speed is supported. Missing assets, unsupported text or runtime failure leave text usable without an alternate engine/voice. Preparation never speaks.
- Recognition produces text, not autonomous tool calls. Choose a new task or exact worker follow-up and approve the exact instruction before it leaves the browser for dispatch.
- Microphone audio is transient: it is not uploaded to Pi Web/an inference provider or persisted by the plugin.

## Foreground voice workflow

1. **Prepare once for the current audio mode.** Cached recognition preparation stays beside the microphone. On first use, open **Speech setup & storage** for explicit download or file import. Nothing records during preparation. Text always works without speech assets.
2. **Talk, pause, refine.** Choose New task or an exact worker. Tap Start recording, then Finish. Optional **Finish on a pause** ends capture after speech energy and 1.2 seconds of quiet; it is an energy heuristic, not intent recognition. Noise can prevent ending and pauses can cut a thought short. The 20-second cap remains. Further recordings append thoughts to the editable draft; they never replace it silently or send it.
3. **Review, then approve.** Propose exact instruction shows the route, worker/revision, model, title and exact text. An empty title gets a deterministic suggestion from the instruction, so typing is not required. Approve exact instruction is still a separate tap. An admission receipt is not proof of delivery or success; uncertain attempts have no replay button.
4. **Work across the workspace.** The attention count and **Review next update** prioritize unreviewed questions, uncertain work, failures and settled results. **Review and reply** reads a fresh saved question and selects that exact worker/revision, with the question beside the composer. Changing target/model discards the old draft and audio. Other workers keep running.
5. **Listen deliberately.** Prepare cached TTS, enable English Heart, then Speak worker status or a selected result/question. Briefings use deterministic status wording, workspace identity and numbered workers (including duplicate titles); no new model/provider is called to summarize. Exact spoken prefixes are visible. Switching back to the microphone requires explicit recognition preparation, not another download if cached.

Updates are metadata checks every five seconds while the panel is visible, not streaming tool progress. Full results/questions are read only on request. **Mark reviewed** applies only to that revision in this panel: it neither answers a worker nor changes its status, and resets on context change/remount. New revisions reappear as updates. Worker numbers distinguish cards within this workspace; exact IDs, not numbers or names, route instructions. No automatic spoken announcements, background notifications or cross-project access are added.

## Operating limits

- Use authenticated **HTTPS** on the phone. Plain `http://192.168…` does not qualify for browser microphone access.
- Foreground use only. Hiding the page, switching context, closing the panel or turning voice off cancels audio work. No wake word, background recording, locked-screen guarantee or native mobile integration is included.
- Transcription can be wrong or hallucinate on noise/silence. Review exact text. Speech finishing is not dispatch approval.
- There is no free-form conversational intent controller. Routing, exact approval and playback use explicit controls; pause ending only creates an editable draft.
- This controls only the selected workspace. Public API4/server API3 is retained; no private routes or API5-only catalogs.
- Stop speaking/off does **not** stop coding workers. Use the ordinary session UI for worker control.
- Core `ask_user`, other extensions' dialogs and ordinary prose questions are not automatically bridged. The companion `voice_request_input` saves a bounded question; an approved follow-up answers it.
- A completed status means the agent turn settled, not proof that its task succeeded.

## Playback and recovery

Recognition and Playback have separate cached preparation, file selection/import and cache inspection/clear controls. Recognition supports explicit download; TTS is import-only with a visible download-unavailable reason until an approved source-aware distribution exists. Selecting a file alone does nothing; tap the matching Import action after returning from the picker. Recognition is about **65 MB**; TTS is about **116 MB**, including its own runtime copy. These are acquisition sizes, not RAM estimates.

Only one heavyweight speech runtime is resident per document. Preparing one releases the other's idle runtime, preserving cached assets, typed drafts and workers. Recording/transcription blocks TTS preparation. **Stop speaking** cancels TTS preparation/synthesis/playback and releases its weights; explicitly prepare again before speaking. Full voice off, context changes and hiding the page revoke playback enablement and instruction allowances. Nothing resumes automatically.

Playback is an explicitly labelled prefix of at most 1,000 UTF-16 code units, including its workspace/worker introduction; full text remains visible. Conservative unsupported-text rejection is intentional: unsupported scripts/symbols, signed numbers/ranges, malformed numeric forms, numeric spans over 15 digits and words/identifiers over 32 characters reject before audio. Supported text can still be mispronounced. No text is sent to another speech engine.

Clear recognition/TTS cache cancels this page's selected pack use under the audio coordinator, then deletes only that pack's exact compiled cache identity. It does not clear the other pack, old revisions, host data or worker ledgers, and is not cross-tab cancellation. Cache presence is not initialized readiness. If audio teardown cannot be certified within five seconds, a document-level unsafe latch blocks audio until page reload; recreating the panel or clearing cache does not reset it.

## Worker safety and recovery

The existing durable worker ledger, exact IDs, payload hashes, revision/sequence fences and conservative `unknown` outcomes are retained. Workers survive panel closure. No uncertain creation or prompt delivery is automatically retried. A companion delivery exception after admission is `unknown`, even if it appears to throw before sending; its saved receipt blocks duplicate delivery and new voice follow-ups.

Admission is saved before session creation and identity before kickoff. A crash between host publication and identity save can still leave an unrecorded published session. Inspect uncertain work instead of submitting a replacement. On backend restart, records become unknown until an already-hosted companion can reconcile them; no saved session is silently resumed.

Ledgers live in the host-provided plugin `dataDirectory`, partitioned by hashed project/workspace IDs. They contain worker/session IDs, statuses, bounded final text/questions, revisions and request hashes—not raw audio. Original task text lives in the ordinary Pi conversation. Worker-provider retention policies still apply.

Prototype limits remain three active/uncertain workers, 30 records and 1000 admission receipts per workspace, and 128 accepted instructions per companion worker. Never clear uncertain work to evade limits. There is no safe retention/cleanup UI yet; offline manual archival loses deduplication history.

## Development

Target contracts: Pi Web `1.202610.3` public browser API 4 / server API 3; Pi companion `1.2.0`; Node 24+.

```sh
npm ci --ignore-scripts
npm run verify
npm run test:browser
npm run test:runtime
```

`verify` runs strict typechecking, unit/contract tests and bundles. Browser checks use Playwright Core with installed Chromium/Edge, fake media/local inference/host and intercepted networking. Set `VOICE_BROWSER_EXECUTABLE` if needed. They do not establish Pixel performance, real microphone behavior, actual model accuracy, TTS intelligibility or device privacy.

`test:runtime` exercises the actual pinned ONNX glue/WASM, including cache eviction/corruption and refusal of its XHR fallback. It does not download model weights or establish transcription accuracy.

### CI and publishing

GitHub Actions runs Node 24 verification and Chromium browser/runtime checks on main pushes and pull requests. A matching stable version tag can run the OIDC npm publishing pipeline, but publication is deliberately blocked while this prototype remains private and unqualified. See [release setup and gates](docs/releasing.md); no token-based fallback or automatic live activation is included.

### Speech packs: no custom host routes

Pi Web's pinned plugin-artifact limit is **16 MiB**, so the approximately **65 MB recognition pack** and **116 MB TTS pack** are acquired separately by the phone, not bundled in the plugin. The current build is approximately **5.50 MB uncompressed**, including two Transformers worker bundles, excluding external weights/runtime packs. Choose **cached preparation**, an **explicit pinned public download for recognition**, or **import a `.pivoice` file** from the phone's files. No reverse-proxy mapping or additional server route is required.

Downloads contact Hugging Face/CDN and jsDelivr for software files—not an inference API—and omit credentials/referrer. Import offers a no-distribution-network alternative when direct downloads are blocked. Every file is checked against compiled byte lengths and SHA-256 hashes before use. Cached preparation and import never silently download missing files.

Inference is cache-only; evicted/corrupted assets fail closed. Browser storage can be evicted and the host shell itself is not made offline. No service worker or background recording is installed. See [ADR 0001](docs/adr/0001-browser-owned-speech-pack-acquisition.md) and [installation/pack instructions](docs/deployment.md).

## Installation boundary

Do not activate the prototype in a live instance without a deliberate acceptance window. Install the checked tarball as a **Pi package**, not merely a web-plugin symlink, so `dist/companion.js` is discovered; enable `compn3rd.voice` and trust/enable its companion for worker sessions. Do not put the speech pack inside the installed package or install a development checkout containing oversized generated assets.

New server plugins require a session-daemon restart arranged outside its hosted sessions. **Restart interrupts active sessions and terminals.** No repository script performs this. Browser reload or Pi `/reload` alone does not activate a new server plugin.

Use a separate data directory, daemon address and web port for isolated acceptance. No OpenAI audio API key or Realtime settings are needed. Text workers retain normal Pi authentication. Keep the package private until live-host, model-asset, Pixel, license and release-owner gates pass. `private: true` is not an exemption from licensing obligations when conveying code/assets to others. Reload the full page when replacing an older OS-synthesis build; do not hot-swap its audio controller.

## Community discovery

This package declares `piWeb.plugins` and the `pi-web.dev-plugin`, `pi-package`,
and `pi-web-plugin` npm keywords required by the
[PI WEB community directory](https://pi-web.dev/community-plugins). No separate
registration or submission is needed. Discovery requires publishing a new public
npm version containing this metadata; npm search indexing may take time. Source
changes alone do not update the directory. The compatibility and installation
requirements above still apply.

These keywords only prepare future discovery. This prototype remains
`private: true`; do not publish until the acceptance, licensing, and owner-release
gates above pass. Source is hosted in the public GitHub repository
[`CompN3rd/pi-web-voice`](https://github.com/CompN3rd/pi-web-voice). Add its confirmed
repository URL to release metadata before any npm release. Original contributions
use MIT; third-party code/assets retain their own terms. See [third-party notices](THIRD_PARTY.md)
and the [licensing audit](docs/licensing-audit.md). Public source does not clear
redistribution of the unqualified speech packs. A [new source-built English phonemizer candidate](docs/phonemizer-candidate.md)
now replaces the untraceable production phonemizer pin and supplies traceable native/build sources and real browser checks. TTS is import-only; old packs require re-export/re-import. Source-aware assembly includes application sources, pinned dependency package archives and [full immutable upstream source/build archives](docs/dependency-sources.md), with checked source comparisons and explicit native-source/combined-work/release gates. No live deployment or release is approved.

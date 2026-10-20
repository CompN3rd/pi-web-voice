# Pi Web Voice

Experimental **phone-browser-local speech interface** for `@jmfederico/pi-web`. Dictate a text task on your phone, review it, send it to an ordinary Pi worker, and optionally hear its result using a local device voice.

**Target device: Google Pixel 8. Real-device acceptance is not yet performed.** Speech recognition runs on the device running the browser, not the Pi Web server. There is no OpenAI Realtime API, separately billed speech service, or cloud speech fallback. Ordinary text workers still use their configured Pi provider/authentication and its usage limits/costs.

The project is private, experimental, and not driving-validated. It is registered as a Pi Web project but is not installed/activated in the live daemon. See [design](docs/design.md), [security](docs/security.md), and [validation](docs/validation.md).

## Architecture

```text
Phone mic → local Whisper worker → editable transcript → exact approval
                                                              ↓
                         Pi Web → ordinary Pi text worker / existing auth
                                                              ↓
Phone speaker ← selected local device voice ← result / saved question
```

- English-only quantized Whisper tiny.en is the initial recognition model, using a browser WASM worker. No Ollama server is needed.
- Speech assets are acquired explicitly by the browser: verified cache, pinned public download, or local `.pivoice` file import. No additional host route or inference service is required. Downloads need bandwidth/storage; local computation uses phone battery/memory.
- Only explicitly selected browser/OS voices marked local are eligible for playback. No local voice means text-only output. The OS locality flag still needs real Pixel offline/network testing.
- Recognition produces text, not autonomous tool calls. Choose a new task or exact worker follow-up and approve the exact instruction before it leaves the browser for dispatch.
- Microphone audio is transient: it is not uploaded to Pi Web/an inference provider or persisted by the plugin.

## Operating limits

- Use authenticated **HTTPS** on the phone. Plain `http://192.168…` does not qualify for browser microphone access.
- Foreground use only. Hiding the page, switching context, closing the panel or turning voice off cancels audio work. No wake word, background recording, locked-screen guarantee or native mobile integration is included.
- Transcription can be wrong or hallucinate on noise/silence. Review exact text. Speech finishing is not dispatch approval.
- There is no free-form conversational intent controller. New-task/reply selection, status reads and playback use explicit controls.
- This controls only the selected workspace. Public API4/server API3 is retained; no private routes or API5-only catalogs.
- Stop speaking/off does **not** stop coding workers. Use the ordinary session UI for worker control.
- Core `ask_user`, other extensions' dialogs and ordinary prose questions are not automatically bridged. The companion `voice_request_input` saves a bounded question; an approved follow-up answers it.
- A completed status means the agent turn settled, not proof that its task succeeded.

## Worker safety and recovery

The existing durable worker ledger, exact IDs, payload hashes, revision/sequence fences and conservative `unknown` outcomes are retained. Workers survive panel closure. No uncertain creation or prompt delivery is automatically retried.

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

`verify` runs strict typechecking, unit/contract tests and bundles. Browser checks use Playwright Core with installed Chromium/Edge, fake media/local inference/host and intercepted networking. Set `VOICE_BROWSER_EXECUTABLE` if needed. They do not establish Pixel performance, real microphone behavior, actual model accuracy or Android TTS privacy.

`test:runtime` exercises the actual pinned ONNX glue/WASM, including cache eviction/corruption and refusal of its XHR fallback. It does not download model weights or establish transcription accuracy.

### Speech pack: no custom host routes

Pi Web's pinned plugin-artifact limit is **16 MiB**, so the approximately **65 MB speech pack** is acquired by the phone, not bundled in the plugin. Choose **cached preparation**, an **explicit pinned public download**, or **import a `.pivoice` file** from the phone's files. No reverse-proxy mapping or additional server route is required.

Downloads contact Hugging Face/CDN and jsDelivr for software files—not an inference API—and omit credentials/referrer. Import offers a no-distribution-network alternative when direct downloads are blocked. Every file is checked against compiled byte lengths and SHA-256 hashes before use. Cached preparation and import never silently download missing files.

Inference is cache-only; evicted/corrupted assets fail closed. Browser storage can be evicted and the host shell itself is not made offline. No service worker or background recording is installed. See [ADR 0001](docs/adr/0001-browser-owned-speech-pack-acquisition.md) and [installation/pack instructions](docs/deployment.md).

## Installation boundary

Do not activate the prototype in a live instance without a deliberate acceptance window. Install the checked tarball as a **Pi package**, not merely a web-plugin symlink, so `dist/companion.js` is discovered; enable `compn3rd.voice` and trust/enable its companion for worker sessions. Do not put the speech pack inside the installed package or install a development checkout containing oversized generated assets.

New server plugins require a session-daemon restart arranged outside its hosted sessions. **Restart interrupts active sessions and terminals.** No repository script performs this. Browser reload or Pi `/reload` alone does not activate a new server plugin.

Use a separate data directory, daemon address and web port for isolated acceptance. No OpenAI audio API key or Realtime settings are needed. Text workers retain normal Pi authentication. Keep the package private until live-host, model-asset, Pixel and release-owner gates pass.

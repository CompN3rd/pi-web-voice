# Validation and delivery record

## Actual-model execution update (2026-11-05)

[Model validation](model-validation.md) records explicitly acquired, hash-verified
Whisper/Kokoro assets, actual desktop Chromium inference, a known synthetic
Kokoro-to-Whisper round-trip, the CI race reproduction/fix, and bounded synthesis
work. The [installed isolated-host test release](isolated-test-release.md) also
passed real worker/question/reply and actual model capture/playback checks.
Listening, Pixel and production-host acceptance remain separate. No production daemon or public release was performed by
these tests. The earlier checkpoint below preserves its historical counts and
then-unrun model status; those statements do not supersede the new measurements.

## Prior ADR 0002 integration checkpoint (historical)

Runtime, audio/controller and UI replacement are implemented: pinned English Whisper recognition and Kokoro `af_heart` TTS run in browser workers; no OS/cloud/system/alternate-voice fallback remains. Separate acquisition/preparation, explicit enablement and Speak, exact selected-pack cache clearing, runtime handoff and persistent audio safety ownership are implemented. Full off/context/hide revokes authority; Stop releases TTS and requires reprepare. Capture tracks stop synchronously while asynchronous graph teardown remains owned, with a five-second deadline/unsafe latch.

Parent verification on the integrated checkout (installed desktop Edge; fake media/host/model unless otherwise stated):

| Check | Result / evidence boundary |
| --- | --- |
| `npm run verify` | **164 unit/contract + 16 deployment tests passed**, strict typecheck and build; deterministic/fake contract evidence |
| `npm run test:browser` | **129 checks passed** using fake media/runtime/host; not model/device acceptance |
| Build inventory | Approximately **4.75 MB uncompressed**, including two Transformers worker bundles, excluding external model/runtime packs; below 16 MiB |
| `npm run test:runtime` | Three real pinned recognition ORT scenarios passed: cached, evicted and corrupt; not model inference |
| `npm run test:tts-runtime` with explicit external phonemizer | Nine real pinned loader/capability scenarios passed **without weights**; cached initialization, corruption/eviction and denied fallback, not full-model inference |
| `npm run test:tts-phonemizer` with explicit external phonemizer | Real pinned phonemizer/tokenizer regressions passed: intact numbers/abbreviations, chunking, unsupported-input rejection and upstream long-input truncation detection; no model audio or intelligibility acceptance |
| Full-model TTS / Pixel / isolated-host acceptance | **UNRUN**; no model-performance, real audio or device privacy claims |

Additional explicit checks are `VOICE_TTS_PHONEMIZER_FILE=/external/phonemizer.js node test/tts-runtime-browser.mjs` and `VOICE_TTS_PACK_FILE=/external/english-tts.pivoice node test/tts-model-browser.mjs` (use shell-appropriate environment syntax). The former uses actual phonemizer/ORT with a substituted model adapter; the latter requires a complete verified external pack and remains unrun. Neither discovers/downloads weights or calls an inference provider. An ORT fallback attempt in failure tests is denied; do not conflate blocked requests with zero attempted requests.

The retired OS/network-voice fixture is removed from the integrated tree. Independent read-only audio/UI and corrected-text reviews found no further concrete defects; subsequent tests cover their noted notification, asynchronous TTS, cache, picker, BFCache and partial-playback gaps. One intermediate full unit run observed the existing service admission test report `unknown` instead of `running`; it did not reproduce in an isolated rerun, twelve consecutive full-unit reruns, or final verification. Assertion diagnostics were improved, but no root cause or fix is claimed for that transient observation.

Native eSpeak corresponding-source/build provenance, combined-work GPL obligations and voice/model provenance block release/conveyance. `private: true` is not an exemption when sending code/assets to others. Full-model tests, independent safety/network review, owner-approved Pixel thresholds and separately authorized isolated-host/device acceptance remain gates. See [qualification](tts-qualification.md) and [ADR 0002](adr/0002-browser-model-tts.md). Conservative unsupported-text rejection is intentional: signed numbers/ranges, malformed numeric forms, numeric cores over 15 digits and phonemizer spans over 32 characters reject before audio. Decimal/grouped-number/time expressions and dotted abbreviations remain intact through phonemization. These bounds address observed upstream input truncation, not pronunciation qualification.

## Historical evidence below

The remaining records preserve prior checkpoints. Their OS-voice permissions, route requirements, package sizes, test counts and Realtime acceptance steps are **historical, not current instructions or Kokoro acceptance**. Current operation is described above and in deployment/security; no obsolete speech-provider setup or OS-voice validation is required by the new architecture.

## Route-free acquisition revision (ADR 0001; superseded playback)

The owner rejected the custom `/pi-voice-speech/` deployment requirement. [ADR 0001](adr/0001-browser-owned-speech-pack-acquisition.md) replaces it with browser-owned verified cache, explicit pinned public download and local portable-file import. The records below describe the earlier route-based implementation until superseded by the route-free verification results recorded here.

The parent first probed public headers, then performed actual CORS downloads of all ten pinned model/runtime assets in installed desktop Edge from a loopback page, with `credentials: omit` and `referrerPolicy: no-referrer`. Every decoded byte length and SHA-256 matched the compiled manifest. Final origins were `https://huggingface.co`, `https://us.aws.cdn.hf.co` and `https://cdn.jsdelivr.net`. No signed CDN query URLs were retained in the report. This is current public-distribution/browser evidence, **not** acceptance of a live Pi host's CSP or a Pixel device. No inference-provider request was made. Runtime HTTP Content-Length can represent compressed bytes; decoded bytes are authoritative.

### Integrated route-free verification

Parent verification at `91efb9a`:

| Check | Result / boundary |
| --- | --- |
| `npm run verify` | Strict typecheck/build, **80 TypeScript unit/contract tests + 11 deployment/export tests passed** |
| `npm run test:browser` | **92 checks passed**; fake inference/media/host, explicit cache/download/import controls, file-picker hide/resume and stale-selection fences |
| `npm run test:runtime` | Actual pinned ORT imported/cached success, empty-cache refusal, cache reuse, eviction/corruption; no model route; native XHR zero |
| `npm run test:model -- --output <verified source directory>` | Actual q8 pipeline imported a pack under `connect-src 'self'`, with no model-serving route; synthetic PCM inference 3,035 ms on the final desktop run; zero further HTTP attempts/requests |
| Production-worker direct-download smoke | Explicit download initialized the full model in desktop Edge, then synthetic inference completed in 4,453 ms with zero inference HTTP; request settings omitted credentials/referrer |
| Package-size gate | Approximately 2.26 MB uncompressed, below 16 MiB; no model/WASM/import payload included |

The direct-download smoke used only public software distribution, not an inference provider. Redirects are browser-managed; final host validation and decoded hashes are enforced by production code. These timings are desktop synthetic-input measurements, not speech accuracy or Pixel predictions.

Portable export: `C:/Users/Wizar/Documents/projects/pi-web-voice-english.pivoice`, **65,179,058 bytes**, SHA-256 `05d2438db64948229efc8d8178a9ebb75efa234466e7226f09e6f281dc681053`. It was generated from the previously verified local assets, without network, and independently checked for magic, all ten assets' order/length/hash, and exact final size. Keep notices/provenance with the plugin and source pack; redistribution licensing remains a release gate.

Independent review accepted the route-free boundaries but found a corruption-recovery bug: explicit Download reused an invalid cached response forever. `91efb9a` permits exactly one verified replacement per bad entry during explicit Download only. Regressions cover cache/inference no-network refusal, successful replacement and failed replacement without publication/retry. Focused independent re-review returned **“No issues found” / “Merge verdict: OK”**; the accepted finding is closed. Reviewers inspected source; the parent separately executed the checks above. Live-host/Pixel acceptance remains unperformed.

## Historical first browser-local redesign (route-based; superseded by ADR 0001)

The owner replaced the paid Realtime architecture with phone-browser-local speech targeting Google Pixel 8. The historical record below describes the **retired Realtime prototype**, not acceptance of the redesigned speech runtime.

Before this redesign, the parent reran `npm run verify` (33 tests, typecheck/build passed) and `npm run test:browser` (17 fake checks passed). The replacement removes the provider setup endpoint and API-key requirement, introduces local speech modules, and retains worker admission/companion contracts. A new server regression confirms obsolete `connect` and audio-upload operations reject without fetching while text list/approval operations remain available.

### Final integrated verification

The parent ran the following against integrated source `6188e71` (subsequent documentation-only edits do not alter runtime behavior):

| Check | Result | Evidence boundary |
| --- | --- | --- |
| `npm run verify` | Passed: strict typecheck, **69 unit/contract + 7 deployment tests**, production build | Fake contracts and deterministic asset/package tests |
| `npm run test:browser` | **85 checks passed** | Installed Edge, 390px viewport, real recognizer state machine with fake PCM/runtime/synthesis/host; intercepted networking |
| `npm run test:runtime` | **3 scenarios passed** | Actual pinned ORT glue/WASM: cached success, post-verification eviction, same-size corruption; native XHR zero throughout; instantiations 1/0/0 |
| `npm run check:package` | Passed; **16 files, approximately 2.24 MB uncompressed**, below 16,777,216 bytes | Dry-run npm artifact total, no model/WASM payload; not installed-host acceptance |
| `npm run test:model -- --output <external pack>` | Passed; 10 verified inference assets, synthetic PCM inference **1,805 ms**, zero further HTTP attempts/requests | Actual desktop Edge q8 pipeline, not accuracy or Pixel evidence |

The smoke used `C:/Users/Wizar/AppData/Local/Temp/pi-voice-speech-assets-46e0ebe` (15 files, 65,196,193 bytes including notices). The parent then re-provisioned it without network from verified source files to **`C:/Users/Wizar/Documents/projects/pi-web-voice-speech-assets`**, outside the plugin root. This is retained local storage, **not a deployed static endpoint**. The build removes obsolete generated speech payloads from the plugin browser directory; the external pack is retained.

The parent explicitly provisioned the pinned public model pack (no inference service) and ran the full production Transformers/Whisper pipeline in desktop Edge from nested plugin URLs. With subsequent HTTP blocked, one second of synthetic sine PCM produced `[Music]` and zero further HTTP requests. Observed desktop inference took about 1.3 seconds on the first run and 3.2 seconds in a later implementation-lane rerun. This is runtime evidence, **not speech accuracy or Pixel latency evidence**; the noise transcription reinforces the need for transcript approval.

No real Pixel 8, actual microphone, Android local-voice, live-host installation or device-level privacy acceptance has been performed. No paid provider calls or live daemon operations were performed.

### Acceptance gates recorded for the superseded route-based version

1. Explicit speech-pack provisioning with pinned artifact integrity/provenance; matching local runtime assets and operator-configured same-origin `/pi-voice-speech/` static path. Plugin package must remain below the pinned host's 16 MiB artifact cap; pack lives outside the package root.
2. Actual Whisper inference on the Pixel 8, including model preparation, short English commands, silence/noise, accuracy, latency, memory and thermal behavior.
3. Speech-only offline readiness after preparation, missing/evicted cache behavior and proof that microphone samples never leave the browser.
4. Local voice enumeration/selection, airplane-mode playback and device-level traffic inspection; browser mocks cannot attest Android system TTS.
5. Permission denial/revocation, stop/off during permission/preparation/inference, page hide, scope switch, repeated recording, headset routes and browser lifecycle.
6. One harmless approved new task and exact follow-up against an isolated real Pi Web instance. No retry of unknown delivery.

### Independent review and remediation

- Runtime review found a P1: actual ONNX glue could fall back from guarded fetch to unrestricted XHR. `46e0ebe` denies XHR in the dedicated worker. The actual-glue regression covers cached success, post-verification eviction and same-size corruption; a negative control against the old worker detected the fallback. Default runtime checks do not require model weights.
- Panel review found a P1: recreating the output wrapper could forget failed OS cancellation, permitting capture while playback remained uncertain. A P2 also identified a fake successful reply to a running worker, contrary to the real backend. `6188e71` adds a page-synthesis-keyed failure latch, structured safety checks and lifecycle regressions, and corrects the fixture/UI settled-status requirement. Independent focused re-review returned **“No issues found” / “Merge verdict: OK.”**
- Parent packaging inspection identified the pinned host's 16 MiB total plugin artifact limit. `c578cb3` separates speech files into an explicitly hosted static pack and adds browser/package size gates, safe external provisioning and a full-model smoke test rather than bypassing the host's public API boundary. Independent runtime/deployment re-review returned **“No issues found” / “Merge verdict: OK.”** Both final reviews inspected source and tests; the parent separately executed all listed validation commands. All accepted review findings are closed.

### Dependency and license release gates

Pinned Transformers.js adds six npm audit advisories (four moderate, two high, including inherited parent advisories) in Node-side development dependencies: `onnxruntime-node` → `global-agent` → `roarr` → `sprintf-js`, and `sharp` native image libraries. The speech browser entrypoint does not use those Node backends; install scripts were disabled. No forced audit upgrade was applied. This is a release review item, not a claim that dependencies are vulnerability-free.

Converted Whisper model provenance/license labels require redistribution review before release. Exact model revision/hashes and notices are retained. Package remains private.

## Historical Realtime prototype record (superseded architecture)

## Local environment and scope

- Date: 2026-10-20.
- Windows, Node `24.20.0`, npm `11.19.0`.
- Pinned compile/test contracts: Pi Web `1.202610.3`, Pi coding agent `1.2.0`.
- Chromium-family browser fixture: installed Microsoft Edge via Playwright Core; 390×844 viewport.
- No live OpenAI/Gemini call, actual microphone access, speaker/Bluetooth route test, live plugin installation, daemon restart, remote push or publication.
- Repository registered as a Pi Web project using the existing local web/API project-registration endpoint; no database files edited. Project ID: `af81b9c3-2ad5-47ee-9c9a-dee388154fea`. Registration does not install or activate the plugin.

## Executed checks

| Check | Result | What it proves / does not prove |
| --- | --- | --- |
| Dependency installation with scripts disabled | Passed; npm audit reported no vulnerabilities at installation time | Reproducible lockfile inputs, not a security certification |
| `npm run typecheck` | Passed | Strict TypeScript against pinned public declarations |
| `npm test` | **33 tests passed** | Companion, provider-setup, ledger and actual companion/service in-memory bus contract fixtures |
| `npm run build` | Passed | Browser/server/companion production bundles generated |
| `npm run test:browser` | **17 checks passed** | Real Edge DOM/render/event lifecycle with fake host, provider, permission/media and intercepted networking |
| `npm pack --ignore-scripts` | Passed; 9 package entries, under 16 MiB | Built browser/server/companion and documentation included; no source secrets/node_modules |
| Live provider/host/device acceptance | **Not run** | Still a delivery gate, not implied by fixtures |

The browser fixture never contacts the live Pi Web daemon or external provider; all requests are fulfilled locally in Playwright routing or aborted. It uses persistent fake track objects so mute and stop assertions refer to the actual track passed to the fake peer. Permission enforcement is tested in backend unit fixtures, **not** by the browser fixture's intentionally permissive fake backend.

Coverage includes:

- Default proposal without dispatch, exact manual approval, duplicate function-call suppression, bounded instruction allowances and workspace isolation.
- Actual companion/service interoperability for a 4,001-character question and normal reply.
- Successful final settlement versus intermediate agent-end/retry behavior; no thinking/tool payload export.
- Durable deduplication/conflicting IDs, disk failure admission blocking, disposal while admission/final writes are pending.
- Lost observation, settled-worker reconnect, external prompt interference, branch rollback and stale follow-up rejection.
- Fire-and-forget delivery with no observed run, including failure after the preparation event but before the expected user message.
- Server-only credential use, fixed provider endpoint, non-leaking rejection, native-audio/VAD config, SDP CRLF preservation and JSON-escaped size bounds.
- Browser scope-change cleanup, late permission after disconnect, mute during pending permission, delayed allowance reply after revocation, unsupported/insecure startup cleanup, active-page visibility handler and active unmount cleanup.
- Escaped HTML output and no horizontal overflow at the tested mobile viewport.

## Review and remediation

Parallel research was followed by an isolated companion implementation lane, parent integration, an independent backend review, a targeted backend follow-up and an independent browser review. Reviewers inspected source/contracts but did not independently execute tests; the parent ran the commands above.

Accepted findings were addressed with regressions: question/model bound mismatches, observation loss for settled sessions, branch sequence rollback, unobserved asynchronous prompt failure, disposal/admission races, JSON SDP bounds, startup mute privacy, delayed permission-response resurrection and preflight connection cleanup. Browser execution independently caught missing Lit class-field configuration and SDP trimming; both were fixed before the listed passing run.

Final targeted source review returned **“No issues found” / “Merge verdict: OK”** for the last watchdog and browser fixes and their immediate blast radius. All accepted findings are resolved. This is source-review evidence, not a whole-system security audit or live-host/provider/device acceptance. Manual-approval cancellation shares the reviewed permission guard; the browser regression directly exercises delayed hands-free arming, not a separate delayed manual-approval scenario.

## Still required before dependable use

1. Install the packed artifact into an **isolated** Pi Web instance, with its own data directory, daemon socket/port and web port. Do not inherit the live instance's addresses. Verify package companion discovery and public capability availability.
2. Configure explicit provider API credentials/billing outside source. Make one harmless real audio conversation and one text-worker request. Compare exact prompt/model/session with spoken claims.
3. Validate actual Realtime event ordering, audio interruption, tool batching, malformed/provider-error paths, output playback policy and provider session expiry. The fake is not a wire-protocol conformance certification.
4. Run current iOS Safari/PWA and Android Chrome/PWA tests: foreground, background, screen lock, permission denied/revoked, device microphone changes, Bluetooth/headset/head-unit routing, echo, music/passenger noise, packet loss and sleep/wake. **No locked-screen guarantee** should be added without native/device evidence.
5. Test process crash windows before/after session publication and ledger saves, restart with open questions, disk-full/read-only directories, model authentication failure, rejected dialogs, concurrent tabs and large catalogs.
6. Test server access protection, provider account spending limits, private data flow and retention policies. A rate/count limit is not a monetary budget.
7. Add durable notification acknowledgements and retention/cleanup UI before long-running production use. Confirm that disabling voice never stops user-owned worker work.

## Known conservative behavior

Unknown/interfered/rewound worker conversations block voice follow-ups; use the normal Pi session UI to inspect/continue, or start a new explicitly approved worker. Generic Pi forms/dialogs are not answered through the voice bridge. Spoken completion reports are best effort and mean a settled final response, not independently verified success. An observed start taking longer than the watchdog can be reported unknown even if it eventually runs; it must not be retried automatically.

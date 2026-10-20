# Validation and delivery record

## Browser-local redesign — current work

The owner replaced the paid Realtime architecture with phone-browser-local speech targeting Google Pixel 8. The historical record below describes the **retired Realtime prototype**, not acceptance of the redesigned speech runtime.

Before this redesign, the parent reran `npm run verify` (33 tests, typecheck/build passed) and `npm run test:browser` (17 fake checks passed). The replacement removes the provider setup endpoint and API-key requirement, introduces local speech modules, and retains worker admission/companion contracts. A new server regression confirms obsolete `connect` and audio-upload operations reject without fetching while text list/approval operations remain available.

Integrated baseline `12991ee` and XHR fix `46e0ebe`: strict typecheck/build and **66 unit/contract tests**, **69 browser fixture checks**, and **three actual-ORT browser runtime scenarios** passed in the implementation lanes. Final post-review counts and package checks are recorded below when complete.

The parent explicitly provisioned the pinned public model pack (no inference service) and ran the full production Transformers/Whisper pipeline in desktop Edge from nested plugin URLs. With subsequent HTTP blocked, one second of synthetic sine PCM produced `[Music]` and zero further HTTP requests. Observed desktop inference took about 1.3 seconds on the first run and 3.2 seconds in a later implementation-lane rerun. This is runtime evidence, **not speech accuracy or Pixel latency evidence**; the noise transcription reinforces the need for transcript approval.

No real Pixel 8, actual microphone, Android local-voice, live-host installation or device-level privacy acceptance has been performed. No paid provider calls or live daemon operations were performed.

### New acceptance gates

1. Explicit speech-pack provisioning with pinned artifact integrity/provenance; matching local runtime assets and operator-configured same-origin `/pi-voice-speech/` static path. Plugin package must remain below the pinned host's 16 MiB artifact cap; pack lives outside the package root.
2. Actual Whisper inference on the Pixel 8, including model preparation, short English commands, silence/noise, accuracy, latency, memory and thermal behavior.
3. Speech-only offline readiness after preparation, missing/evicted cache behavior and proof that microphone samples never leave the browser.
4. Local voice enumeration/selection, airplane-mode playback and device-level traffic inspection; browser mocks cannot attest Android system TTS.
5. Permission denial/revocation, stop/off during permission/preparation/inference, page hide, scope switch, repeated recording, headset routes and browser lifecycle.
6. One harmless approved new task and exact follow-up against an isolated real Pi Web instance. No retry of unknown delivery.

### Independent review and remediation

- Runtime review found a P1: actual ONNX glue could fall back from guarded fetch to unrestricted XHR. `46e0ebe` denies XHR in the dedicated worker. The actual-glue regression covers cached success, post-verification eviction and same-size corruption; a negative control against the old worker detected the fallback. Default runtime checks do not require model weights.
- Panel review found a P1: recreating the output wrapper could forget failed OS cancellation, permitting capture while playback remained uncertain. A P2 also identified a fake successful reply to a running worker, contrary to the real backend. Both were accepted for remediation and independent re-review.
- Parent packaging inspection identified the pinned host's 16 MiB total plugin artifact limit. Speech files are being separated into an explicitly hosted static pack rather than bypassing the host's public API boundary.

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

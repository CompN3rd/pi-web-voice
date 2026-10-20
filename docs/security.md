# Security and privacy boundary

## Trust model

Pi Web plugins and ordinary workers run trusted code with normal daemon/agent permissions. Use authenticated HTTPS and a trusted private/VPN deployment; the plugin adds no separate browser-user authentication. A phone visiting plain LAN HTTP does not get the desktop localhost microphone exception.

Use only pinned public Pi Web package entrypoints. Do not read private host databases, scrape provider credentials, or expose arbitrary session routes. Local speech does not sandbox a coding worker.

## Data flows

| Data | Destination/storage |
| --- | --- |
| Microphone samples | Phone browser memory and local recognition worker only |
| Speech models/runtime | Explicit pinned public download or local file import → verified browser cache; cached preparation has no download |
| Download metadata | Hugging Face/CDN and jsDelivr see ordinary request metadata only after explicit download; credentials/referrer omitted |
| Unapproved transcript | Editable browser state; not a worker instruction yet |
| Approved instruction | Pi Web ledger/admission and ordinary Pi conversation/provider |
| Worker metadata | Scoped backend ledger and browser |
| Bounded final result/question | Scoped backend ledger/browser; optional explicitly selected local TTS voice |
| Raw audio recordings | Not persisted or uploaded by the plugin |
| Provider credentials | Not accessed by the speech layer; ordinary Pi workers retain their existing auth |
| Thinking/raw tool payloads | Not exported by the companion |

No paid speech endpoint, native cloud-backed browser recognition, or silent cloud fallback is permitted. No custom host routes are required. The user explicitly chooses cached preparation, pinned public download, or `.pivoice` file import. Cached preparation/import cannot silently fetch missing files. Download requests carry no microphone samples, transcripts, worker data, authentication or referrer. Public distributors may redirect; initial sources and accepted final HTTPS distribution hosts are constrained, but browser Fetch cannot attest every redirect hop. Hash/decoded-length verification—not CDN trust alone—gates asset use. Imported files cannot replace the compiled manifest or supply arbitrary paths/code versions. See [ADR 0001](adr/0001-browser-owned-speech-pack-acquisition.md).

Runtime URLs are internal cache keys, not real host routes. Inference fetch is cache-only; the dedicated worker denies XMLHttpRequest to block the runtime's alternate loader. Only verified module bytes become executable blob imports. Offline speech readiness and full offline Pi operation are different claims.

Browser speech synthesis is restricted to explicitly selected voices with `localService === true`, checked again at playback. Missing/changed/remote voices fail to text. If the OS/browser cancellation call throws, a page-level safety latch blocks further playback and microphone capture across wrapper recreation, context changes and remounts. The UI warns that audio may still be playing; page reload is the explicit recovery boundary. A new wrapper is not evidence that playback stopped. That flag is not proof about all Android engine networking; verify actual device behavior in airplane mode and with device-level traffic observation. Browser request interception cannot inspect OS service traffic.

## Authority

- Recognition produces editable text, never an automatically dispatched command.
- A new task or exact follow-up target/revision is chosen explicitly. The user approves exact text/model/target on screen.
- Speech modules have no backend authority. Worker results are data, not instructions to the voice UI.
- Server-issued instruction allowances remain workspace-scoped and bounded. The UI uses per-instruction approval. Pending grants are fenced by context generation and permission epoch; stale grants are revoked by exact token.
- Hide, disconnect/off, unmount and context changes cancel capture/inference/playback, clear stale state and revoke old-context authority. Remote revocation may fail after transport loss; backend expiry/count limits remain the backstop.
- Microphone permission is not dispatch permission. End recording is not approval. A recognized “yes” is not approval.
- Ordinary workers may edit files/run tools under their existing permissions. `completed` means final settlement, not independently verified success.

## Failure handling

Audio is bounded and memory-only. Finishing/canceling capture releases microphone tracks; pending permission and recognition results must not resurrect old state. Text remains available after unsupported capabilities, missing assets, local inference errors or unavailable voices. No automatic remote fallback.

Mutating worker requests are never automatically retried. Durable request IDs and payload hashes deduplicate accepted work; changed payloads reject. Admission precedes session creation, session identity precedes kickoff. Disk failure blocks further admission. There is no transaction spanning host publication and plugin persistence: a crash can leave an unrecorded published session, so uncertain outcomes require inspection.

Companion sequence and backend revision fences reject stale replies. Branch changes/unrelated prompts invalidate attribution. Backend restart marks records unknown until a hosted companion can reconcile. No saved session is silently resumed. A delivery watchdog may mark a slow start unknown even if it subsequently runs; never retry merely because it is unknown.

Stopping speech/closing the panel does not cancel user-owned workers. Generic Pi dialogs and permissions must be handled in the regular conversation UI.

## Release and device gates

Keep the package private/experimental. Do not install/activate it or restart a live daemon without explicit authorization; restart interrupts active sessions and terminals. Test using an isolated instance first.

Required real-device checks include HTTPS/CSP and asset loading, permission denied/revoked, microphone indicators after cancel, delayed permission, browser hide/lock, memory pressure, cache eviction, weak networks, Bluetooth/headsets, silence/noise/hallucinations and local TTS behavior. Fake browser tests are not device/privacy acceptance. Do not rely on this for safety-critical or driving interaction.

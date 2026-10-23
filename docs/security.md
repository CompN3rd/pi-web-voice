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
| Bounded final result/question | Scoped backend ledger/browser; optional explicit local Kokoro playback; generated PCM remains transient in browser memory |
| Raw audio recordings | Not persisted or uploaded by the plugin |
| Provider credentials | Not accessed by the speech layer; ordinary Pi workers retain their existing auth |
| Thinking/raw tool payloads | Not exported by the companion |

No paid/remote speech endpoint, native browser recognition, OS `speechSynthesis`, Google/system speech or alternate model/voice fallback is permitted. Both recognition and synthesis execute in browser workers; approved worker text still uses normal Pi/provider transport. No custom host routes are required. The user explicitly chooses cached preparation, pinned public download, or `.pivoice` file import. Cached preparation/import cannot silently fetch missing files. Download requests carry no microphone samples, transcripts, worker data, authentication or referrer. Public distributors may redirect; initial sources and accepted final HTTPS distribution hosts are constrained, but browser Fetch cannot attest every redirect hop. Hash/decoded-length verification—not CDN trust alone—gates asset use. Imported files cannot replace the compiled manifest or supply arbitrary paths/code versions. See [ADR 0001](adr/0001-browser-owned-speech-pack-acquisition.md).

Runtime URLs are internal cache keys, not real host routes. Inference fetch is cache-only; the dedicated worker denies XMLHttpRequest to block the runtime's alternate loader. Only verified module bytes become executable blob imports. Offline speech readiness and full offline Pi operation are different claims.

TTS is restricted to the pinned English Kokoro `af_heart` voice at normal speed. The adapter bypasses upstream unverified voice caches/downloads and truncating generation helpers. Verified phonemizer bytes are evaluated only after bootstrap transport restrictions are installed. Cache misses, corruption and unsupported text fail closed; no engine substitution or automatic replay is allowed. These restrictions confine reviewed loaders, not arbitrary hostile JavaScript.

Preparation does not enable or start playback. Enable Heart and Speak are separate actions. Source snapshots, context generations, worker revisions and latest-detail-read tickets fence stale playback. Selected prefixes are labelled; conservative text/tokenizer preflight rejects unsupported text before synthesis rather than silently deleting it. No transcript, spoken text, phonemes or PCM are included in diagnostics.

The document-level coordinator owns one heavyweight runtime, capture/playback exclusivity and selected-pack cache clearing. It retains ownership while asynchronous capture or playback teardown settles, with a five-second deadline. Microphone tracks are stopped synchronously; failed/uncertain graph cleanup latches audio unsafe until full page reload, across context changes and panel recreation. Text and worker inspection remain usable. Cache clear does not reset the latch or delete another pack, old cache revisions or host/ledger data. Other tabs and unrelated host audio are outside this coordinator's control.

## Authority

- Recognition produces editable text, never an automatically dispatched command.
- A new task or exact follow-up target/revision is chosen explicitly. The user approves exact text/model/target on screen.
- Speech modules have no backend authority. Worker results are data, not instructions to the voice UI.
- Server-issued instruction allowances remain workspace-scoped and bounded. The UI uses per-instruction approval. Pending grants are fenced by context generation and permission epoch; stale grants are revoked by exact token.
- Hide, disconnect/off, unmount and context changes cancel capture/inference/playback, clear stale state and revoke old-context authority. Remote revocation may fail after transport loss; backend expiry/count limits remain the backstop.
- Microphone permission is not dispatch permission. End recording is not approval. A recognized “yes” is not approval.
- Ordinary workers may edit files/run tools under their existing permissions. `completed` means final settlement, not independently verified success.

## Failure handling

Audio is bounded and memory-only. Finishing/canceling capture releases microphone tracks; pending permission and recognition results must not resurrect old state. Text remains available after unsupported capabilities, missing assets, local inference errors or unavailable TTS. No automatic remote speech or alternate-voice fallback. Stop speaking releases TTS weights and requires explicit preparation again; full off/context/hide also revokes playback enablement.

Mutating worker requests are never automatically retried. Durable request IDs and payload hashes deduplicate accepted work; changed payloads reject. Admission precedes session creation, session identity precedes kickoff. Disk failure blocks further admission. There is no transaction spanning host publication and plugin persistence: a crash can leave an unrecorded published session, so uncertain outcomes require inspection.

Companion sequence and backend revision fences reject stale replies. Branch changes/unrelated prompts invalidate attribution. Backend restart marks records unknown until a hosted companion can reconcile. No saved session is silently resumed. A delivery watchdog may mark a slow start unknown even if it subsequently runs; never retry merely because it is unknown.

Stopping speech/closing the panel does not cancel user-owned workers. Generic Pi dialogs and permissions must be handled in the regular conversation UI.

## Release and device gates

Keep the package private/experimental. Embedded eSpeak native corresponding-source provenance, voice provenance and combined GPL obligations block release/conveyance. `private: true` is not an exemption when sending executable code/assets to others. Do not install/activate it or restart a live daemon without explicit authorization; restart interrupts active sessions and terminals. Test using an isolated instance first.

Required real-device checks include HTTPS/CSP and asset loading, permission denied/revoked, microphone indicators after cancel, delayed permission, browser hide/lock, memory pressure, cache eviction, weak networks, Bluetooth/headsets, silence/noise/hallucinations and real model TTS intelligibility, bounded output, offline/cache-only behavior and device-level privacy. Fake browser tests are not device/privacy acceptance. Do not rely on this for safety-critical or driving interaction.

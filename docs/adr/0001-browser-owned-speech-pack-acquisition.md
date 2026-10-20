# ADR 0001: Browser-owned speech-pack acquisition without host routes

- **Status:** Accepted; implementation and validation tracked in `../validation.md`
- **Date:** 2026-10-20
- **Decision owner:** Project owner, via explicit rejection of additional deployment routes
- **Scope:** Speech model/runtime acquisition only; no change to worker authority or text-provider authentication
- **Supersedes:** The `/pi-voice-speech/` static-route requirement in the initial browser-local redesign

## Context

The voice interface must run speech recognition on the device hosting the browser (initial target: Google Pixel 8), without a separately billed inference service. The pinned public Pi Web API4/server API3 host admits plugin artifacts up to 16 MiB. The selected Whisper tiny.en q8 model, tokenizer and matching ONNX runtime need about 65 MB before browser/runtime overhead.

An earlier implementation moved the large files outside the plugin package and required an operator-managed same-origin `/pi-voice-speech/` reverse-proxy/static route. That met the package limit but imposed infrastructure changes on every plugin installation. The owner rejected this requirement. A plugin must not invent private host endpoints, modify the reverse proxy or require another server to make its core feature work.

Model-file distribution is not remote inference. Public downloads can be free of API billing while still disclosing download metadata and depending on third-party availability. This distinction must be explicit, not hidden behind “local.”

## Decision

Keep the normal plugin small and make **the browser own acquisition and cache readiness**. Provide three separate user actions, none of which opens the microphone:

1. **Prepare cached pack:** verify all expected cached assets and initialize local recognition. This is the default preparation mode and performs no model/runtime download.
2. **Download pinned pack:** explicit consent to fetch only compiled-in, revision/version-pinned public distribution URLs, verify every decoded file's expected byte length and SHA-256, then initialize local recognition. No API key, cookies, authorization headers, referrer, microphone samples, transcript or worker content accompanies these requests.
3. **Import pack from file:** select a portable `.pivoice` file using the phone's file picker. Verify it against the plugin's compiled asset manifest, populate the browser cache, and initialize local recognition without external download requests.

The import action is a first-class alternative when third-party connectivity, CORS or the host's existing `connect-src` policy blocks direct downloads. Do **not** solve a blocked download by requiring new routes or weakened host security policy. Text input/output remains available if neither acquisition path succeeds.

### Distribution and trust

Model sources are pinned to the selected Hugging Face model revision. Runtime sources are pinned to the exact npm package version through jsDelivr. The build derives runtime hashes from the matching locked dependency; file versions and hashes must agree. No user-entered URL, mutable remote manifest, “latest” version, provider credential resolution or inference endpoint is accepted.

Public model downloads may redirect to the distributor's CDN. Use HTTPS, omit credentials and referrers, constrain initial URLs and accepted final distribution hosts, and verify decoded bytes before caching/use. Browser Fetch follows CORS redirects internally: application code cannot attest every intermediate hop. This is a documented download-metadata trust boundary, not a promise of no third-party requests. Do not log signed CDN query URLs.

Only verified runtime-module bytes may become executable blob imports. Native browser speech recognition is not a fallback. Browser/OS TTS continues to require an explicitly selected voice marked local; it is unrelated to speech-pack downloads.

### Portable format

Version 1 is deliberately not a general archive:

- Eight ASCII magic bytes: `PIVOICE1`.
- Raw inference asset bytes concatenated in the exact compiled manifest order.
- Exact total length: eight plus the sum of expected asset lengths.
- No paths, executable instructions, remote URLs, supplied manifest, compression or archive extraction.

Read bounded Blob slices in the dedicated worker. Validate header, total size and every per-file hash. A pack cannot change the model, runtime version, code hash or cache keys. A changed asset set requires an exported pack matching the installed plugin. The developer export command verifies existing local source files and writes atomically to an explicitly chosen path outside the plugin root. Provenance/license notices remain in the plugin and source pack; exporting a private prototype is not release/redistribution approval.

### Cache and inference boundary

Use versioned Cache Storage and synthetic module-relative URLs as **internal keys only**. They are not host routes and must never be fetched from Pi Web. Do not depend on a service worker or host-root mapping.

A partial, individually verified cache may survive cancellation; it is not readiness. Every preparation verifies all required files. Wrong/missing/corrupted assets fail closed, with explicit import/download recovery, never an automatic network retry. Storage eviction can require re-acquisition. Browser cache does not make the Pi host shell or text workers offline.

After acquisition, the inference worker uses only the verified cache fetch adapter. XMLHttpRequest remains disabled to prevent ONNX Runtime's alternate loader from bypassing this boundary. No native network downloader is used during transcription. Cancel/hide/context changes terminate pending worker acquisition/inference and fence late callbacks. No microphone opens until an explicit recording action after successful preparation.

## Alternatives considered

| Alternative | Disposition |
| --- | --- |
| Bundle the whole pack in the plugin | Rejected: exceeds pinned host's total artifact cap |
| Require a same-origin static/reverse-proxy route | Rejected by owner: infrastructure coupling is inappropriate for plugin installation |
| Add private host endpoints or change host limits | Rejected: violates pinned public-API boundary and is not plugin-owned |
| Relay the pack through text/session peer messages | Rejected: bulk binary transfer is not the worker control protocol; increases host/storage/transport complexity |
| Download directly with no integrity checks | Rejected: remotely distributed runtime code must match the reviewed build |
| Direct downloads only | Rejected: CORS, policy or connectivity can block them; import avoids mandatory infrastructure changes |
| File import only | Safe minimum, but avoidable transfer friction when explicit pinned public downloads work |
| Cloud recognition or reuse ChatGPT OAuth for audio | Rejected: violates cost requirement or lacks a supported authentication path |

## Consequences

### Benefits

- Standard plugin installation; **no custom routes, reverse-proxy mappings or extra service**.
- Plugin remains below the 16 MiB cap.
- Phone-local recognition with explicit acquisition privacy choices.
- Imported model/runtime data cannot override the compiled trust policy.
- Existing admission receipts, exact approvals, worker revisions and uncertain-outcome behavior remain unchanged.

### Costs and limits

- Approximately 65 MB download/file transfer, browser cache usage, and significant inference RAM/battery use.
- Direct download contacts Hugging Face/CDN and jsDelivr; hosts observe normal network metadata. Their availability/CORS behavior can change.
- Import requires getting a matching file onto the phone; no OS-independent background installer is promised.
- Host/browser must still support the plugin's existing worker, blob-module and WASM execution. Import bypasses model-download network policy, not execution restrictions.
- Actual Pixel performance, microphone behavior and OS TTS locality remain unverified until device acceptance.
- Existing dependency advisories and model redistribution licensing remain separate release gates.

## Acceptance criteria

- No production request to `/pi-voice-speech/` or synthetic cache-key URLs.
- No model download on page load, cached preparation, import or inference.
- Direct download requires its own explicit user action and uses only pinned sources without credentials/referrer.
- Bad hashes, malformed/truncated/oversized files, unknown URLs and storage failures cannot produce a ready recognizer.
- Cancel/hide/context change during acquisition cannot resurrect state or open a microphone.
- Actual pinned runtime and full-model tests exercise import/cache inference without a model-serving route; no inference network attempts.
- Package-size, existing lifecycle/browser and worker-authority regression suites remain green.
- README/deployment/security documentation describes this decision, not the superseded route workaround.

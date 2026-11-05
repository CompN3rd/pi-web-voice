# Voice desk redesign validation

The immutable product direction remains [vision.md](vision.md). Implemented behavior and capability boundaries are documented in [design.md](design.md) and the README.

## Repository checks

Executed after implementation:

- `npm run verify`: strict typecheck; 172 unit/contract tests and 16 asset/deployment tests passed; bundles built.
- `VOICE_BROWSER_EXECUTABLE=/state/home/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome npm run test:browser`: 151 checks passed after final review fixes.
- `npm run test:runtime` with the same browser override: actual pinned ORT cached, evicted and corrupt scenarios passed, with no native XHR fallback.
- `git diff --check`: passed.
- Measured bundle before adding this validation note: 4,581,637 browser bytes; package 4,764,854 uncompressed bytes, below the 16 MiB host limit.

The available runner was Node 22.22.2, below the declared Node 24+ target. Passing here does not qualify the target host runtime; repeat verification on Node 24+ during isolated-host acceptance. The initial browser invocation without an executable override failed configuration; rerunning against the existing Chromium executable passed. No browser or speech models were downloaded for these checks.

Browser tests use fake PCM, inference, Web Audio and host seams, with intercepted networking. They cover attention ordering, exact revision targeting, appendable drafts, optional pause ending, receipts and uncertain delivery, stale asynchronous results, context cancellation, mobile layout, and microphone startup/unsafe-state labels. They are not live acceptance.

## Independent review

A read-only design audit identified post-admission prompt exceptions incorrectly classified as failed. These now retain receipts and become unknown; regression tests cover exceptions before/after apparent delivery, no duplicate resend, rejection of fresh follow-ups, and late lifecycle events.

A fresh read-only implementation review identified an incorrect microphone-off badge during startup or unsafe teardown. The badge now distinguishes opening, recording, stopping, uncertain and inactive states; browser regressions cover delayed startup and unsafe teardown.

The implementation agent timed out after producing its changes. The parent preserved the working tree, reran validation, commissioned the fresh review, and applied its microphone-label finding. No installation, activation, publication, push or live daemon restart was performed.

## Remaining gates

Real Whisper/Kokoro model quality, Pixel 8 latency and pause thresholds, microphone/headset behavior, memory/thermal load, live-host CSP/integration, and licensing/redistribution qualification remain unverified. Cross-project access, general input-dialog bridging, federation and hands-free dispatch remain outside this implementation's authority. Package privacy and release gates remain unchanged.

# Synthetic desktop full-model validation

This record covers explicitly authorized public model acquisition and actual browser
inference on 2026-11-05. It is not listening, microphone, Pixel, driving, or installed
Pi Web host acceptance. No paid inference, live plugin activation or production
daemon operation was performed by these tests. The package remains private.

## Environment and acquisition

- Linux desktop Chromium `156.0.8078.4`, installed executable
  `/state/home/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome`.
- Portable Node `24.22.2`, outside the repository at
  `/data/pi-web-voice-model-tests/tooling/node-v24.22.2-linux-x64/bin/node`.
  Public nodejs.org archive SHA-256:
  `48cc0e21e048790e54c0cf5749c2725005313d652651c40b7a21feb9697aaf75`.
- All model/runtime bytes were checked against the existing compiled lengths and
  SHA-256 pins. Whisper used explicit `speech:provision --download`. Kokoro model,
  voice and model card were retrieved only from the immutable revision in
  `scripts/tts-pack.json`, then passed through `speech:provision --pack tts
  --from-models ... --candidate ...` and source-aware `tts:assemble`.
  TTS browser/CLI automatic download remains disabled; no alternate weights,
  provider credentials, model fallback, or inference service was used.
- Native candidate:
  `/data/pi-web-voice-phonemizer/build-6-integrated-docs`, with the pinned binary,
  source archive, notices and mapping. Assembly reused verified
  `dependency-archives` and `upstream-source-archives` from that external tree.
  Initial complete assembly took 16.3 seconds. Source/native/GPL, voice provenance
  and owner release review remain required; successful assembly is not clearance.

## Concrete failures fixed

1. **CI build-output race.** An untouched `d96bcc4` archive with fresh
   `npm ci --ignore-scripts` and Node 24 reproduced the same failed snapshot as CI
   run `42107470856`: concurrent `speech-deployment.test.mjs` inserted
   `obsolete-test.onnx` and `obsolete-test.wasm` into the before-build snapshot.
   The obsolete-file cleanup regression now lives with the build-round-trip
   regression in `build-cleanup.test.mjs`. Node serializes these top-level tests;
   unrelated files remain parallel. All original cleanup/hash/package assertions
   remain. Three complete isolated asset-suite reruns passed (39 tests each).
2. **Previously unrun full-model upload.** Playwright refuses an in-memory
   `setInputFiles` buffer above 50 MiB. The 116 MB TTS smoke now supplies the
   already verified external pack path. Small loader fixtures still use buffers;
   production import/hash checks are unchanged.
3. **Oversized synthesis work.** With the former 512-token synthesis chunks,
   actual initialization and short synthesis succeeded, but the long fixture hit
   the unchanged 120-second inactivity limit. One measured short run took
   30,833 ms for 78,000 samples (3.25 seconds of audio); the overall failing run
   took 161.3 seconds. The model's 512-token capacity is now distinct from a
   conservative **128-token synthesis budget**, including two special tokens.
   Full-prefix preflight, no-loss splitting, atomic numeric/abbreviation rejection,
   32 chunks, 30 seconds PCM per chunk, 120 seconds PCM total, 120-second inactivity
   and 300-second job limits are unchanged. This improves bounded work; it is not
   a natural-latency or device-performance claim.

The mandatory model smoke requires actual non-silent finite bounded PCM for short
and multi-chunk text plus cancellation and explicit cache reprepare. Original long
fixtures remain separate bounded stress cases: completion and timeout-fail-closed
are reported distinctly. A timeout must reject further chunks/plans until explicit
new preparation; it is not reported as successful long-text playback. Other
errors still fail the suite. No production timeout or PCM assertion was relaxed.

## Measured inference

These are observed wall-clock timings on shared desktop hardware, not a benchmark
or prediction for Pixel 8. The TTS runtime uses the production single-thread WASM
path and pinned `af_heart` at normal speed.

| Actual-model check | Observed result |
| --- | --- |
| Whisper q8, initial sine smoke | 10 verified assets imported; 7,502 ms inference; 20.6 seconds command time; no further HTTP attempts/requests |
| TTS cold import/prepare with 128-token chunks | 7,515 ms |
| TTS fixed short sentence | One chunk, 78,000 samples / 3.25 seconds audio, 27,181 ms synthesis |
| TTS multi-chunk, `Hello world. ` repeated 12 times | Two chunks, 278,400 samples / 11.6 seconds audio, 94,033 ms synthesis |
| TTS explicit cache reprepare after canceling pending synthesis | 9,513 ms preparation, then 77,400 samples / 3.225 seconds audio in 26,918 ms |
| Long stress, `Hello world. ` repeated 60 times | **Timeout-fail-closed**, not complete playback: 5/8 chunks, 855,600 partial samples, 300,001 ms; further chunk/plan rejected |
| Long stress, `antidisestablishmentarianism ` repeated 25 times | **Timeout-fail-closed**, not complete playback: 5/9 chunks, 852,000 partial samples, 300,001 ms; further chunk/plan rejected |
| Known synthetic Kokoro sentence into real Whisper | `Hello world, this is local English speech.`; 5,805 ms speech inference; exact words matched after case/punctuation normalization; 26.7 seconds command time including build, preparation and a 6,648 ms sine regression |

The complete TTS suite passed its mandatory PCM/cancel/reprepare checks and the
separately classified stress checks in 769,682 ms of browser execution (about
12.8 minutes). All reported native fetch, native XHR, unexpected fetch and guarded
transport attempts were zero. Neither long fixture completed playback on this CPU.

The round-trip uses the production area-average resampler from 24 kHz to 16 kHz,
not incorrect sample-rate relabeling. It verifies one known synthetic sentence,
not general accuracy, pronunciation, or real microphone behavior. Both recognition
inferences made zero further HTTP attempts/requests. The normal app persists no
PCM. Only an explicit test output option wrote this fixed synthetic sentence to
an exclusive external file; no user or microphone audio was recorded.

## Additional executed checks

- Final `npm run verify`: strict typecheck, **173 unit/contract + 39 asset tests**
  and build passed, 66.3 seconds. An intermediate rerun caught a
  changed qualification document while this implementation was still editing;
  the final verification ran with a stable source tree.
- Browser fixture: **151 checks**, 125.0 seconds; fake media/runtime/host, not
  full-model or installed-host evidence.
- Recognition runtime: **three** actual pinned ORT cache/eviction/corruption
  scenarios, 30.0 seconds.
- TTS runtime: **ten** actual pinned phonemizer/ORT loader/capability scenarios,
  96.8 seconds; model adapter substituted, no weights. Eviction/corruption can
  attempt a forbidden fallback which is denied; this is not zero-attempt evidence.
- Real phonemizer/tokenizer fidelity: 5.1 seconds; 29 no-loss chunks for the long
  numeric prose, intact atomic expressions, and explicit rejection when a valid
  15-digit expression fits 512 model tokens but exceeds 128 synthesis tokens.
- Package gate: no external model, voice, WASM or `.pivoice` payload included;
  below the pinned 16 MiB uncompressed artifact ceiling.

## Exact reusable local artifacts

All paths below are outside the repository/install root. Preserve source/license
handoffs with any separately authorized transfer; these are not published assets.

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| `/data/pi-web-voice-model-tests/english-recognition.pivoice` | 65,179,058 | `05d2438db64948229efc8d8178a9ebb75efa234466e7226f09e6f281dc681053` |
| `/data/pi-web-voice-model-tests/tts-handoff-initial/english-tts.pivoice` | 116,019,350 | `bdd8d37be188219f9bcd98a901b83be990b3ea2bafce7fbdf26a9d6f3aa9eb1f` |
| `/data/pi-web-voice-model-tests/synthetic/hello-kokoro.json` | 1,687,151 | `d6b4ff9ada8651954334a46c0e14685f3e6a82a5887975cf8531e95e2fe0075f` |

The initial source-aware handoff predates the synthesis-budget and test fixes;
its pack bytes remain valid because the compiled asset pins did not change. Use
the final source-aware handoff supplied with the checked candidate for source
review, not that initial application snapshot. The synthetic fixture is fixed and
hash-addressed for repeatable recognition input; this does not claim bit-identical
Kokoro output on future synthesis runs.

Logs are retained under `/data/pi-web-voice-model-tests/logs`. Reproduction commands
and explicit optional synthetic fixture flags are in [deployment](deployment.md).
Real-host paths/CSP, listened output, Pixel latency/storage/heat, real microphone,
headset/lifecycle and device-level privacy still require their separate acceptance
windows. Exact instruction approval, selected-workspace API4/server3 boundaries,
cache-only inference and no fallback behavior are not relaxed by these tests.

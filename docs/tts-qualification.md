# Browser-model TTS qualification — implemented, acceptance incomplete

This is **implementation and automated-check evidence, not full-model, release or device acceptance**. ADR 0002 remains the delivery contract. The panel now uses the Kokoro worker and owned Web Audio playback controller; OS synthesis and its voice enumeration/diagnostics are removed, with no OS/cloud/alternate-voice fallback. Full-model TTS inference, Pixel and isolated-host acceptance remain **unrun**. Native corresponding-source provenance and combined GPL obligations block release/conveyance.

## Exact artifacts inspected

The following public npm tarballs were retrieved into an external temporary audit directory, verified against registry SHA-512 integrity, and inspected without installation or executing lifecycle scripts:

| Package | Published version | Registry integrity |
| --- | --- | --- |
| `kokoro-js` | `1.2.1` | `sha512-oq0HZJWis3t8lERkMJh84WLU86dpYD0EuBPtqYnLlQzyFP1OkyBRDcweAqCfhNOpltyN9j/azp1H6uuC47gShw==` |
| `phonemizer` | `1.2.1` | `sha512-v0KJ4mi2T4Q7eJQ0W15Xd4G9k4kICSXE8bpDeJ8jisL4RyJhNWsweKTOi88QXFc4r4LZlz5jVL5lCHhkpdT71A==` |

`kokoro-js/dist/kokoro.js` imports Transformers and the phonemizer separately. Its package requires Transformers `^3.5.1`, compatible with this project's existing `3.8.1`, but installing it would not by itself prove a single runtime instance. No dependency was added. The implemented adapter uses this project's existing public `StyleTextToSpeech2Model`, `AutoTokenizer` and `Tensor` exports directly, not Kokoro's private loaders or hidden package imports. Each speech worker bundles the same pinned Transformers version; the coordinator permits only one heavyweight speech runtime resident per document.

Published `generate()`/`stream()` use `truncation: true`. `generate_from_ids()` still invokes the private voice loader, which reads unverified `kokoro-voices` data and falls back to `resolve/main/voices/...`. None is an acceptable production generation boundary. The adapter accepts verified voice bytes, enforces the actual tokenizer budget without truncation, and supplies style/speed tensors directly. `tts-text.ts` implements conservative normalization and phoneme/token fidelity checks with source attribution. Real-tokenizer compatibility fixes have regression coverage. Unsupported text rejects conservatively rather than receiving an unqualified semantic rewrite; this is not evidence of pronunciation accuracy for numbers, abbreviations or code. Notices retain the upstream references.

## Pinned candidate inventory

`scripts/tts-pack.json` records:

- Model revision `1939ad2a8e416c0acfeecc08a694d14ef25f2231` of `onnx-community/Kokoro-82M-v1.0-ONNX`.
- `model_quantized.onnx`: 92,361,116 bytes. Its SHA-256 is the immutable revision's LFS object ID; weights have **not** been downloaded or exercised.
- `af_heart.bin`: 522,240 bytes, likewise pinned using revision-specific LFS metadata; not exercised as a voice.
- Config/tokenizer/model-card bytes retrieved at that revision and SHA-256 hashed. Tokenizer configuration specifies 512 tokens; its postprocessor adds two `$` tokens. The tokenizer normalizer discards unsupported symbols, so token count alone will not establish text fidelity.
- The existing ORT `1.22.0-dev.20250409-89f8206ba4` glue/WASM, checked against installed bytes as for recognition.
- Published `phonemizer@1.2.1/dist/phonemizer.js`: 1,322,380 bytes, SHA-256 `193481f474f7c1ea81df3195d18b45df8ef7254dbdccb3f193d60215c4897bec`.

The TTS binary inventory is 115,849,893 bytes, plus its eight-byte `PIVOTTS1` header. Each pack remains self-contained, including duplicated ORT bytes. These are acquisition sizes, **not peak RAM estimates**. TTS limits are 96,000,000 bytes per file, 128,000,000 total and 12 files; recognition retains its original 64,000,000 / 100,000,000 / 20 limits and byte ordering.

Only the compiled manifest defines paths, order, lengths and hashes. `speech-assets.json` next to an operator's pack remains informational, never an executable/imported manifest. Browser and CLI selection accept only `recognition` or `tts`. Existing commands default to recognition. A TTS `.pivoice` cannot pass a recognition import header check, even if payload sizes happen to match.

## Phonemizer findings and unresolved licensing

The exact published phonemizer bundle includes an Emscripten-generated eSpeak runtime and embedded compressed data. It initializes at module evaluation, not only at the first `phonemize()` call. Its public English phonemizer API is exported at the end of that same bundle. Static inspection found no `fetch()` calls, dynamic imports or nested-worker constructors, but did find Emscripten lazy-file XHR code. **Static inspection does not establish zero attempted network requests.** The production bootstrap denies alternate transports before dynamically importing dependencies/verified executable bytes. Guarded real-browser phonemizer/ORT loader checks have passed without weights; those results are not full-model acceptance.

The npm package reports Apache-2.0 and ships that license. The exact published license is retained in `scripts/speech-licenses/PHONEMIZER-LICENSE` and copied with external TTS pack notices. This is not a conclusion that all embedded eSpeak-derived code/data is Apache-licensed. The upstream eSpeak NG project has GPL-3.0 licensing; the exact embedded source/build correspondence and applicable distribution/source obligations remain unresolved. Do not distribute/release this candidate based only on npm metadata. Native engine source, patches and toolchain correspondence and combined-work GPL obligations remain release/conveyance blockers. `private: true` is not an exemption when code/assets are sent to others. The GPL text and `TTS-NOTICE.txt` are retained, but are neither a source offer nor legal clearance. Model-card Apache-2.0 also does not settle voice-data provenance independently.

Pinned phonemizer source revision from npm metadata: `6835144b7ee9043129222549c1ed2f6a27216278` in `xenova/phonemizer.js`. The source tree includes generated `src/espeakng.worker.js` and `data/espeakng.worker.data`; that alone is not demonstrated corresponding-source compliance for embedded eSpeak.

## Implemented runtime and UI

- Shared integrity/acquisition with independent compiled recognition/TTS format, path, hash and size policies; wrong-pack rejection and cache-only inference.
- Explicit `--pack tts` provisioning/export, preserving default Whisper behavior. `--from-pack` reuses verified external assets; downloads still require `--download`.
- Guarded TTS bootstrap, verified phonemizer/ORT loader, direct public-model adapter and versioned bounded worker protocol. Voice data is checked, not taken from upstream `kokoro-voices` caches.
- Bounded text/tokenizer preflight, transient mono 24 kHz PCM, queue backpressure and user-gesture Web Audio. Exact labelled playback prefixes remain at most 1,000 UTF-16 code units; unsupported text rejects without a fallback.
- Document-level coordinator for single-runtime residency, half-duplex audio and exact selected-pack cache clearing. Capture stops tracks synchronously and retains asynchronous close/resume settlement; uncertain capture/playback teardown has a five-second deadline and persistent unsafe latch until reload.
- Independent recognition/Playback preparation, explicit download, picker/import, cache inspection/clear, English Heart enablement and Speak controls. No preparation or successful import speaks automatically. Stop releases TTS and requires reprepare; full off/context/hide revokes broader permissions and playback enablement.
- Lifecycle, source/revision/detail-read and picker tickets fence stale work; worker dispatch/admission contracts remain unchanged.

## Automated evidence and limits

The integration handoff reports `npm run verify` passing **164 unit/contract + 16 deployment tests**, and `npm run test:browser` passing **129 fake-media/runtime/host checks**. The build is approximately **4.75 MB uncompressed**, including two Transformers worker bundles, below 16 MiB and excluding external packs. Counts describe that checkpoint, not an assertion that every ADR matrix item has device evidence. See [validation](validation.md) for current and historical records.

Guarded real phonemizer and pinned ORT loader checks previously passed without model weights. They exercise cached/imported initialization, eviction/corruption and refusal of alternate loading; an ORT XHR fallback attempt under failure is denied, not described as zero attempts. The full-model adapter is substituted in this loader test, so it does not establish Kokoro inference. Real tokenizer compatibility has separate regression coverage, not an intelligibility result. The real pinned phonemizer/tokenizer browser regression also passed in desktop Edge with no unexpected requests or model weights.

Current admission additionally rejects signed numbers/ranges, malformed numeric forms, numeric cores over 15 digits and phonemizer spans over 32 characters. Decimal/grouped-number/time expressions and dotted abbreviations remain atomic through phonemization and chunking. Real pinned dependency probes demonstrated silent truncation of long words/numbers before tokenization; conservative input bounds reject those inputs before eSpeak. Tokenizer fidelity uses single-token public decoding because the pinned null sequence decoder inserts spaces. This is input-retention evidence, not pronunciation or model-audio qualification.

Additional opt-in checks use only explicitly supplied external files:

- `VOICE_TTS_PHONEMIZER_FILE=/external/phonemizer.js node test/tts-runtime-browser.mjs` — pinned published phonemizer plus installed matching ORT, no weights or automatic downloads.
- `VOICE_TTS_PACK_FILE=/external/english-tts.pivoice node test/tts-model-browser.mjs` — verified complete external pack and production adapter; **unrun**. Intended checks include bounded finite PCM, multiple chunks, cancellation/reprepare and inference-network refusal.

Set these environment variables using the appropriate shell syntax; `VOICE_BROWSER_EXECUTABLE` can select installed Chromium/Edge. No browser/model installation or provider request is automatic.

## Remaining gates

Resolve exact native corresponding-source/build provenance, combined-work GPL obligations, converted-model and voice provenance and release-owner review before release/conveyance. Merely retaining license texts or keeping npm publication private does not resolve these obligations.

Run separately authorized full-model TTS and shared recognition-model regression checks with verified external assets; synthetic desktop PCM would still not establish intelligibility or Pixel performance. Independently review the implemented safety/network matrix and any remaining text-fidelity limitations. Then, only in an authorized acceptance window, validate authenticated isolated-host paths/CSP and Pixel model accuracy/intelligibility, latency, peak memory, repeated handoffs, storage pressure, heat/battery, microphone indicators, cancellation, lifecycle, headsets and device-level privacy against owner-approved thresholds.

No TTS weights, real TTS inference, live-host acceptance or Pixel measurements are established by this checkpoint. No license or real-device gate is waived.

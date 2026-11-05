# Pinned TTS tokenizer fixtures

`tokenizer.json` and `tokenizer_config.json` are the small, pinned Kokoro tokenizer assets described by `scripts/tts-pack.json`. Tests verify their exact byte lengths and SHA-256 hashes before using the public Transformers.js `PreTrainedTokenizer` constructor. No model weights are included or needed. These fixtures exercise the actual character vocabulary, including its null decoder (sequence decode inserts spaces; fidelity is checked with public single-token decode).

## License and provenance

These two fixtures are unmodified files from `onnx-community/Kokoro-82M-v1.0-ONNX` at revision `1939ad2a8e416c0acfeecc08a694d14ef25f2231`. Its pinned model card declares Apache-2.0; the full license text is retained at [`scripts/speech-licenses/KOKORO-JS-LICENSE`](../../../scripts/speech-licenses/KOKORO-JS-LICENSE). That filename identifies the shared license-text location, not the source of these tokenizer files. See [third-party notices](../../../THIRD_PARTY.md). The project's MIT license does not replace these terms.

## Numeric/text fidelity checks

```sh
node --import tsx --test test/tts-text.test.ts test/tts-tokenizer.test.ts
```

The optional real phonemizer/browser regression additionally requires an **already present**, external source-built `phonemizer.mjs` and an installed Chromium/Edge executable:

```sh
VOICE_TTS_PHONEMIZER_FILE=/external/native-build/phonemizer.mjs \
VOICE_BROWSER_EXECUTABLE=/installed/chromium \
node test/tts-phonemizer-browser.mjs
```

As an alternate variable name for the same source-built production module, use `VOICE_TTS_CANDIDATE_FILE=/external/build/phonemizer.mjs` instead (never set both file variables). The candidate's hash is pinned in `scripts/phonemizer/candidate.json`; this cannot override the compiled production manifest. Retired published bytes no longer pass. The same selection works for `node test/tts-runtime-browser.mjs`, exercising guarded cache/import loading at the production phonemizer seam. See [build/source evidence](../../../docs/phonemizer-candidate.md).

The script verifies the external module against the compiled TTS inventory (or the checked-in candidate pin) and verifies both tokenizer fixtures. Playwright fulfills only an in-memory document, the local test bundle and the verified phonemizer module; all other requests fail the test. It neither downloads software/weights nor synthesizes audio. It tests the production text adapter with both real pinned dependencies, comparing emitted tokens against direct whole-expression phonemization. It also retains the dash-vocabulary and unsupported-phoneme regressions.

Qualified structural handling: integers; dot decimals; comma groups of three digits with optional decimals; 24-hour `H:MM`/`HH:MM` with optional `:SS`; dotted initialisms such as `U.S.` and `e.g.`. These expressions are indivisible during token-budget splitting. Oversized atomic expressions fail preflight. Numeric expressions are limited to **15 total digits**, and every non-punctuation phonemizer span is limited to **32 characters**, before phonemization. The real pinned module produces identical incomplete output for 100 versus 511 repeated digits and for 100 versus 511 repeated `x` characters; an output-token budget alone cannot detect this loss. These conservative ceilings reject unqualified long words/identifiers rather than trusting that output. Tests cover both ceiling boundaries. Titles `Dr.`/`Mr.` and ordinal `3rd` are checked against direct phonemization without introducing expansion rules.

Unqualified signed numbers and numeric dash ranges reject, rather than converting a minus/range to an em-dash pause. Malformed grouping, multiple decimal points, out-of-range times, leading-dot decimals and mixed numeric punctuation/units (for example `3.14kg`) reject. Numeric expressions adjoining other text without whitespace can also reject conservatively. Ordinary textual dashes still normalize to the supported em dash; punctuation outside atomic expressions is retained.

These are input-structure, vocabulary and rejection checks, **not pronunciation/intelligibility acceptance**. They establish no audio/model/device performance, Pixel acceptance or live-host compatibility.

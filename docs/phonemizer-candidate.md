# Source-built English phonemizer: concrete resolution milestone

**Production pin replaced and browser-tested; import-only, not live-deployed or release-cleared.** This is a new
candidate, not an attempt to identify/reproduce the unknown native inputs of
`phonemizer@1.2.1`. Production now pins this replacement with a new cache identity.
No old-binary fallback or invented CDN URL exists. TTS download requests are
refused before cache/network access and the UI explains import-only acquisition.
Recognition downloads/cache identity are unchanged. New TTS cache:
`pi-voice-tts-509a9b40952d3a5adb703aec` (retired:
`pi-voice-tts-e12b51622742c29ef163e9e9`). Re-export/re-import old TTS packs; their
bytes/hashes are incompatible despite the unchanged `PIVOTTS1` format.

## Source and build

- Native: eSpeak NG **1.52.0**, commit
  `4870adfa25b1a32b4361592f1be8a40337c58d6c`.
- Compiler: Emscripten **3.1.74**, source revision
  `1092ec30a3fb1d46b1782ff1b4db5094d3d06ae5`, Linux x86_64 toolchain build
  `c2655005234810c7c42e02a18e4696554abe0352`.
- Build-time JS runtime: **Node 22.16.0**, exact archive hash pinned.
- Native source/toolchain/Node public archive URLs and SHA-256 are in
  [`pins.json`](../scripts/phonemizer/pins.json). No system compiler, CMake,
  Docker, SDK activation, global installation or native source patch is used.
  Python 3.12+ and Linux x86_64 are documented host prerequisites; the actual
  Python/platform are recorded, not claimed hermetically pinned.
- [`build.py`](../scripts/phonemizer/build.py) compiles both the offline data
  compiler and browser library to WASM with the pinned compiler. The offline
  compiler runs under pinned Node to generate English dictionary and base
  phoneme/intonation tables from that same native source. Only `en`/`en-US`
  voice definitions and `en_dict` are embedded, alongside shared phoneme tables.
- Original MIT bridge/wrapper/configuration and build recipe are checked in at
  [`scripts/phonemizer`](../scripts/phonemizer/README.md). The API is
  `phonemize(text, "en-us") -> Promise<string[]>`, preserving the existing
  `EnglishPhonemizer` / `TtsLoader.phonemize` seam. No native audio output is
  exposed. Initialization is lazy and failure-sticky; calls cannot interleave
  the native cursor. Other languages, NUL and input over 1,000 UTF-16 units
  reject. Production's stricter supported-text/span rules are unchanged.

## Measured artifacts

The retained build is external to the checkout at
`/data/pi-web-voice-phonemizer/build-6-integrated-docs/` on the implementation machine:

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| `phonemizer.mjs` | 1,491,829 | `055adbf200338f5cefff27e16e81d9a27b9f73a3e2482f59ebb721e6ca5ab78d` |
| `source.tar.gz` | 23,180,087 | `59ac8d7747f40a961c817c1c047383a43a029b2028dae150f2cd481b7edc7595` |
| `NOTICES.txt` | 119,290 | `9510ab28004ff6d7bd27116318e51f41e3f70dab3cb7bbec83e59fbe372ab00f` |

[`candidate.json`](../scripts/phonemizer/candidate.json) is the checked-in
measured pin, including each embedded data file's hash and the exact builder
input hashes. External `SOURCE.json` maps the executable to source/archive and
notices. `build-record.json` records exact compiler/data commands, controlled
environment and host; `build.log` retains compiler output. Initial experimental
builds are not the pinned candidate.

`source.tar.gz` includes the **complete unmodified native source archive**,
including all in-tree licenses and dictionary/data attribution; original
wrapper/bridge/config/build sources; and Emscripten's embedded-runtime preferred
source (`src` and `system`, including in-tree notices). The general-purpose
compiler and Node binaries remain external, with exact retrievable archive
pins. This supplies native engine/data build correspondence instead of merely
copying GPL text or pointing at an unrelated revision.

Build from the repository with explicit external paths (downloads require
`--download`; omit it to use already-present hash-checked archives):

```sh
python3 scripts/phonemizer/build.py \
  --output /data/new-phonemizer-build \
  --downloads /data/phonemizer-downloads --download
```

The standalone source archive includes its own build entrypoint and instructions;
no npm installation or repository checkout is needed to rebuild the engine.
**Executed reproducibility check:** extracted this exact `source.tar.gz` to
`/data/pi-web-voice-phonemizer/rebuild-final-source/`, invoked only its included builder
with the verified download cache into fresh
`/data/pi-web-voice-phonemizer/build-7-final-source-rebuild/`, and compared outputs with
`cmp`. The module is **byte-identical** (same 1,491,829 bytes and SHA-256 above),
as are all seven embedded data files. Source/archive builder hashes and native
archive/license presence were independently checked. Source archive/build-record
bytes encode invocation-specific paths/logs and are not claimed identical
between invocations.

## Independent review fix and integrated source assembly

Review found that inherited `EM_LLVM_ROOT`, `EM_BINARYEN_ROOT` and `EM_NODE_JS`
could override pinned Emscripten configuration. The builder now constructs a
**subprocess environment allowlist**, not a partial denylist: fixed system
Python PATH, external HOME/TMP/cache, explicit configuration and deterministic
locale/time settings. `python3 -B scripts/phonemizer/test_build.py` covers
conflicting SDK/compiler/Python/loader variables. Both the retained build and
source-package rebuild were run with deliberately invalid inherited tool paths;
they still use the pinned tools and produce identical binary/data. The source
archive/README/build-record hashes were refreshed. This fixes review P1, not a
claim that earlier retained builds were contaminated.

`npm run tts:assemble` now assembles a real external handoff. The exercised
reviewed engine/application handoff is
`/data/pi-web-voice-phonemizer/distribution-4-reviewed/`. The subsequent
[preferred-source handoff](dependency-sources.md) adds full upstream archives
and source comparisons without changing these native pins:

- Exact candidate binary, full engine source archive, notices and source mapping,
  checked against repository pins (never the producer's arbitrary hashes).
- Exact **working-tree** application source/build inputs from the source allowlist,
  with every path/length/hash recorded. The filename allowlist is not a secret-content scanner; source review remains necessary. No `.git`, `node_modules`, credential-like file paths,
  symlinks, generated plugin output or unexpected binary payloads are copied.
- Eight actual lock-SHA512-verified npm dependency package archives (not links
  alone), complete bundled/ORT/native notices, and the full lock inventory.
  That milestone did not yet supply complete upstream preferred sources.
  The [subsequent source inventory](dependency-sources.md) supplies seven full
  upstream archives, identifies embedded Jinja 0.5.3 and retains the unresolved
  native correspondence/recursive-source closure boundary.
- `DISTRIBUTION.json` identifies producer/consumer boundaries and remaining
  gates. No release-approval checkbox can waive them. The browser consumes only
  compiled manifest bytes; source metadata never changes executable policy.

The source-only handoff has `packIncluded: false` because no weights were
acquired. With an existing verified local pack, the same command verifies its
model card and every executable/model/voice byte and includes
`english-tts.pivoice` atomically. Tests separately exercise fake model bytes in
the low-level exporter; no fake model is presented as a real TTS qualification.
Standalone TTS `speech:export` is refused in favor of this source-aware route.
See [exact commands and boundaries](deployment.md#tts-pack-preparation-and-playback).
The native builder's standalone `productionIntegrated: false` field describes
its lack of automatic deployment; the application's manifest is separately
updated here, not rewritten by the native producer.

## Executed browser evidence

Desktop Chromium **156.0.8078.4**, installed executable (no browser download):

```sh
export VOICE_BROWSER_EXECUTABLE=/path/to/installed/chrome
export VOICE_TTS_CANDIDATE_FILE=/data/pi-web-voice-phonemizer/build-6-integrated-docs/phonemizer.mjs
node test/tts-phonemizer-browser.mjs
node test/tts-runtime-browser.mjs
```

Do not set both `VOICE_TTS_CANDIDATE_FILE` and `VOICE_TTS_PHONEMIZER_FILE`.
Either environment variable name now selects only the hash-verified source-built
production module; the retired published binary cannot pass. No untrusted source
manifest selects executable bytes. The production manifest omits all TTS download
URLs, and the same compiled import/cache policy is exercised by these tests.

Passed:

- Actual source-built native engine + actual pinned Kokoro tokenizer: 15
  atomic-expression/span cases (decimals, grouping, times, initialisms, titles,
  ordinals, accepted numeric/word ceilings), 15 conservative rejection cases,
  punctuation/token round trips, prose and five-chunk token-budget splitting.
- Native CLI reference IPA for `Hello world.`, `3.14`, `U.S.`, and multi-clause
  `Good morning! Ready?`; concurrent initial calls, empty input and wrapper
  boundary rejection. No discarded trailing clause in the checked example.
- Ten production guarded-loader scenarios using the real candidate and ORT:
  missing cache, explicit import and cache reuse, phonemizer/WASM eviction and
  corruption, operation without obsolete decompression/stream capabilities and refusal when WASM is missing. The adapter's
  model inference is substituted; phonemization and ORT initialization are real.
- Successful initialization uses zero native fetch/XHR/unexpected requests or
  alternate transports. ORT's WASM-failure path attempts its XHR fallback once;
  the production guard denies it. This is not described as zero attempted
  transport in every failure scenario.
- Four build/wrapper unit tests pin source mapping, prevent inadvertent
  production substitution, verify cursor ownership and failure handling.
- `npm run verify`: strict typecheck, 173 unit/contract tests + 32
  asset/release/notice/build tests, bundles and package-size validation passed.
  `npm run test:browser`: 151 fake-media/runtime/host checks passed.
  `npm run test:runtime`: actual recognition ORT cached/evicted/corrupt scenarios
  passed. `npm run check:package` passed with no external speech payload.
  Project checks used host Node 22.22.2, not the Node 24+ release/CI target;
  the isolated native build used its separately pinned Node 22.16.0.

The new native engine still produces identical truncated output for 100 versus
511 repeated digits or `x` characters. Existing pre-phonemization limits of
15 numeric digits and 32 characters per span therefore remain necessary.
Source provenance does not remove native text limitations or establish
pronunciation accuracy.

## Licensing boundary and next gates

Original bridge/build/wrapper files retain MIT. Native eSpeak/Unicode tools
retain **GPL-3.0-or-later**; the linked candidate is not relabelled Apache/MIT.
The source artifact preserves native component/data licenses and embedded
Emscripten/musl/compiler-support notices. Root package license and
`private: true` are unchanged; worker/module isolation is **not** a GPL exception.

The native source handoff and assembled application/dependency evidence are
**not yet a verified full application Corresponding Source distribution**. Before any combined application conveyance,
review the actual work/recipients under GPLv3 §1/§6(d), application/dependency
source availability, user-facing legal notices/source access and delivery terms.
No public upload, release, live daemon restart or installation was performed.

Independent read-only integration review found no issues in this technical
milestone: import-only enforcement, pinned source mapping, atomic assembly and
the environment-isolation fix were inspected. The parent independently reran
verify (173 + 32 tests), browser (151 checks) and recognition runtime checks.
This does not certify preferred-source completeness or legal compliance.

Next: close the retained native binary/source correspondence and recursive
source-delivery gaps, plus combined-work delivery terms, then full Kokoro
qualification. Immutable dependency sources and executed comparisons are now
recorded in [preferred-source evidence](dependency-sources.md). Converted-model/
voice provenance, full-model regression, Pixel performance/intelligibility/privacy,
isolated-host and release-owner gates stay open. No model weights or voice binary
were downloaded, no real audio inference was run, and no live-host/device
acceptance is claimed.

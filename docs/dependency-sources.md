# Dependency preferred-source evidence

**Concrete source archives acquired and checked; not release clearance.** This
supersedes the earlier “npm archives only” limitation, not the remaining native
binary correspondence, combined-work or device gates. Original per-file terms,
package privacy and import-only TTS policy are unchanged.

## Actual bundle boundary

The esbuild inputs for the UI, server and both inference workers identify eight
direct packages. `scripts/dependency-sources.json` records those exact input
paths, release evidence, seven complete upstream repository archives, byte
lengths/SHA-256 and source/build member hashes. These are full source trees, not
npm metadata checkboxes or stripped license-only archives. Upstream in-tree
notices, build scripts/configuration, locks and tests are retained. GitHub
archives do **not** populate git submodules.

| Package | Version | Immutable source revision |
| --- | --- | --- |
| lit, lit-html | 3.3.3 | `20afabd3c5bfd49fdcdf1b8518e05c7f99a46db6` |
| lit-element, @lit/reactive-element | 4.2.2, 2.1.2 | `0fc671bc390cac3b9900fc3616347eeeecd91d5a` |
| @huggingface/transformers | 3.8.1 | `2ec882e739e4cb461f8d440d4d7394cbf5372429` |
| onnxruntime-common | 1.21.0 | `e0b66cad282043d4377cea5269083f17771b6dfc` |
| onnxruntime-web | 1.22.0-dev.20250409-89f8206ba4 | `89f8206ba4f1c22c39e0297fb55272e8ce8cd7d0` |
| @jmfederico/pi-web | 1.202610.3 | `29f0ace6d955a458a947bb0f03673fa069afb8da` |
| @huggingface/jinja **embedded in Transformers** | 0.5.3 | `f5d9f06cc86cf89deeee8bfa371eee3620a2e8b1` |

Lit, Transformers and Pi Web revisions come from the exact npm release's
`gitHead`; archive contents were then inspected, not merely those declarations.
ORT common uses the peeled `v1.21.0` tag; ORT web includes the full revision in
npm `__commit.txt`. Jinja's release commit was located in the upstream package
history, then checked against the exact published source.

### Executed source comparisons

The offline verifier reads only pinned archives, without extracting or running
upstream code. It verifies the eight direct npm packages against the application
lock, all upstream archives against SHA-256, and named source/build members:

- 119 Transformers JavaScript source files match the upstream tree exactly.
- All 21 ORT common TypeScript source files match the **1.21.0** tree.
- 205 ORT web TypeScript files match the native revision. The remaining generated
  `lib/version.ts` differs only by the development version substitution.
- Eight source-map source bodies from actually consumed Lit component files
  match their upstream TypeScript. `lit` itself supplies re-export entrypoints;
  its full preferred sources/build files are retained, not counted as eight
  additional implementations.
- Pi Web's public `src/server-plugin-api.ts` and build/type configuration are in
  its complete archive. Independently transpiling that file with installed
  TypeScript 5.9.3 (ES2022/ESNext) yielded **byte-identical** published
  `dist/server-plugin-api.js`. No private host API or host implementation was
  imported/executed. This is not a rebuild of the entire host.
- Transformers' webpack source map contains one embedded npm module:
  `@huggingface/jinja/dist/index.js`. Its complete `sourcesContent` is
  byte-identical to **jinja 0.5.3**, selected by Transformers' upstream lock;
  all seven Jinja TypeScript sources match the pinned upstream tree. Its npm
  archive and full monorepo source/build archive are both retained. The locally
  installed transitive **0.5.10 is not that embedded version**. Its MIT text is
  now included in generated bundled notices, with a source-map identity check.
- ORT's bundle source map also includes its own `js/common` code at the **web
  native revision**, independently of the directly bundled common 1.21.0. Both
  complete ORT trees are retained. Do not substitute one revision for the other.

No evidence was found that `sharp`, `onnxruntime-node`, the Pi host's entire
runtime dependency tree or the installed Jinja 0.5.10 is in these browser/server
bundles. The upstream source archives naturally contain more code than the
plugin consumes. This is not a complete development/host SBOM or proof that
all published bundles have been reproduced from source.

## Native inventory: pinned declarations, not closed correspondence

The web revision's `cmake/deps.txt` is retained and hashed. All **40** rows are
transcribed exactly into `onnxNative.declaredDependencies`: upstream URL and
upstream SHA-1, including optional/platform/test dependencies and prebuilt
`protoc` tools. These hashes are **upstream declarations**, not independently
acquired/verified dependency archives. The exact source tree also preserves
CMake selection logic and in-tree patches.

The revision's Git tree supplies three immutable gitlinks (repository/path/full
revision recorded): `emsdk`, `onnx` and `libprotobuf-mutator`. Their contents are
not in GitHub's ORT tarball. The `.gitmodules` Emscripten branch reference alone
would not have been an immutable pin; the full gitlink is retained instead.

Still unresolved: which optional native inputs actually went into the published
WASM, recursive native dependency/submodule archives, release build options,
any release-specific patches and the exact Emscripten/runtime-support source
and toolchain correspondence. Neither a commit string nor a complete ORT tree
proves the exact native executable was built from it. The upstream third-party
notice remains conservatively complete, not a precise link inventory. No ORT
native rebuild or full source-closure certification was performed.

## Acquisition and verification

```sh
# Explicit public software acquisition, never a lifecycle hook:
npm run tts:assemble -- --candidate /data/verified-native-build \
  --output /external/new-source-handoff \
  --dependency-archives /external/npm-archives --download-dependencies \
  --source-archives /external/upstream-archives --download-sources

# Independent offline source/build-member and npm/source comparison (Python 3.12+):
python3 -B scripts/verify-dependency-sources.py \
  --source-archives /external/upstream-archives \
  --dependency-archives /external/npm-archives
```

Omit both download flags for cached assembly. Each new archive must match its
reviewed length/hash before caching/copying; missing, corrupt or symlinked files
fail closed. Sources use public HTTPS with credentials/referrer omitted, no
redirects and bounded reads. Assembly copies the seven full source archives
(521,508,668 bytes total) and the embedded Jinja npm archive into
`upstream-sources/`, alongside the eight direct npm archives in `dependencies/`.
`UPSTREAM-SOURCES.json` is hashed by `DISTRIBUTION.json`. The browser never
interprets either manifest. Source files are external to installed plugin roots.

No production Whisper/Kokoro weights or voice asset were acquired. Full upstream
repository archives do contain their own tests and fixtures (including ORT's
small model fixtures); do not describe those archives as containing only text.
No source archive is published, installed or used to change executable policy.

## Executed validation

On Node 22.22.2 / Python 3.14.4 (not the Node 24 CI target):

- `npm run verify`: 173 unit/contract tests, 39 asset/release/source/build tests,
  typechecking and package build passed. The tests check actual esbuild inputs,
  the prebundled Jinja identity/notice, archive corruption/symlinks, explicit
  acquisition bounds and deterministic full-build output.
- `npm run test:browser`: 151 fake-media/runtime/host checks passed using installed
  Chromium. `npm run test:runtime`: real ORT cached/evicted/corrupt cases passed.
- `npm run check:package`: passed; external source/weight archives are excluded.
- The offline archive verifier passed the source comparisons above. The new
  downloader was also exercised against public HTTPS for a fresh Lit source
  archive and Jinja npm archive; both matched their reviewed length/SHA-256.

Independent review identified one offline-verifier memory bound issue: archive
files were read in full before rejecting an oversized cache entry. The verifier
now checks pinned source lengths/the npm size cap before opening data, and hashes
incrementally in 1 MiB chunks. A sparse oversized-file regression proves early
rejection without a data read; multi-chunk hash and symlink checks also pass.
The parent reran the complete offline verifier successfully after this fix.

These are technical checks, not live-host/device/model or legal acceptance.

## Current handoff and non-destructive cleanup inventory

On the implementation machine, `upstream-source-archives/` and `source-research/`
under `/data/pi-web-voice-phonemizer/` retain verified inputs and inspection logs.
The reviewed handoff is `distribution-6-reviewed-sources/`; it is
source-only (`packIncluded: false`), review-required, not a release. Its exact
working-tree snapshot is authoritative in `DISTRIBUTION.json`; later edits
require a new handoff rather than overwriting that evidence.

Preserve current `build-6-integrated-docs`, `build-7-final-source-rebuild`,
`distribution-4-reviewed`, all source/binary/notice/mapping artifacts, logs and
pinned download/archive caches. The supervisor removed only the five retired `work` directories listed below,
after checking the preserved source/module/notice/mapping/log files. SHA-256
checks before and after deletion confirmed that all retained artifacts were
unchanged; the record is `/data/pi-web-voice-phonemizer/retired-work-cleanup.json`.
The generated checkout cleanup is removing
`dist/browser/local-recognizer.js` on a full build; a regression compares every
output hash before/after an intervening `--speech-only` build.

These **specific retired work directories only** were removed (allocated KiB
at inspection):

| Directory below `/data/pi-web-voice-phonemizer/` | KiB |
| --- | ---: |
| `build-1/work` | 1,664,536 |
| `build-2/work` | 1,664,532 |
| `build-3-from-source/work` | 1,664,564 |
| `build-4-controlled/work` | 1,664,568 |
| `build-5-controlled-rebuild/work` | 1,664,600 |

These are extracted compiler/native trees, temporary compiled intermediates and
caches created by the builder, about **7.94 GiB** total. Their enclosing builds
retain standalone `source.tar.gz`, `SOURCE.json`, module, notices, build record
and log outside `work`. They are not needed by the new source checks/assembly.
The enclosing builds, extracted source handoffs, current build work, user files
and caches needed to rebuild the retained evidence were preserved.

Combined-work delivery/recipient terms, user-facing source/notices, converted
model/voice provenance, full-model and device/isolated-host acceptance and owner
release approval remain separate gates. This technical evidence does not decide
those questions or change the project's original MIT per-file coverage.

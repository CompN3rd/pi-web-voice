# Plugin installation and browser speech packs

The plugin requires **no additional host route, reverse-proxy mapping or inference service**. [ADR 0001](adr/0001-browser-owned-speech-pack-acquisition.md) supersedes the earlier `/pi-voice-speech/` static-route design. Do not configure that route for this version.

## What is installed

The normal Pi package contains the panel, recognition worker/worklet and TTS bootstrap/worker/controller JavaScript, text backend/companion, notices and pinned speech-asset metadata. Keep it below Pi Web's pinned **16 MiB total uncompressed artifact** limit. The current build is approximately 4.75 MB uncompressed, including two Transformers worker bundles. Model weights, voice/phonemizer assets and large WASM files are acquired by the browser separately and do not belong in the installed package directory.

Use the normal Pi package installation flow after explicit authorization. Enable the plugin and its companion as described in README. New server-plugin activation still requires an authorized daemon restart outside hosted sessions; this interrupts active sessions. Nothing in the build/acquisition tools performs live activation or restarts.

## First recognition use on the phone

After authorized isolated-host setup and license review, open Pi Web through its existing secure HTTPS deployment, open Local voice and choose a recognition acquisition method. TTS has separate controls described below:

- **Cached preparation:** verify the existing browser speech cache and initialize recognition. No model download is permitted. Use this after a previous successful import/download.
- **Explicit download:** consent to roughly 65 MB of pinned public model/runtime downloads from Hugging Face and its CDN, and jsDelivr. No API key or separately billed inference service is involved. Requests omit credentials/referrer; the distribution hosts still see normal request metadata. Every file must pass compiled size/hash checks.
- **File import:** select a matching `.pivoice` file from the phone's Files picker, then tap **Import selected speech pack**. Selecting a file alone starts no import or microphone. This separate tap accommodates Android temporarily hiding the page for its native picker. Import is local and does not contact model-distribution hosts. This is the alternative when direct downloads are blocked by CORS, connectivity or the existing host policy; no proxy-route workaround is required.

Preparation/import/download never opens the microphone. Once ready, explicitly record, finish, review the editable transcript and approve the exact text instruction. Inference is local and cache-only; approved worker text still goes to Pi and its configured provider.

Browser cache can be evicted. Missing/corrupt files fail closed; choose an explicit acquisition action to recover. The entire Pi app is not made offline and no service worker/background recorder is installed. The existing host must support workers, WASM and verified blob-module execution; file import does not bypass execution restrictions. No arbitrary remote speech provider or URL is configurable.

## Creating an import file

A developer/operator can produce a matching pack using the checked-out source and locked dependencies. This is optional packaging tooling, not an installation prerequisite when direct download works.

```sh
npm ci --ignore-scripts

# Explicit public-download opt-in, outside the plugin repository/install root.
npm run speech:provision -- --output /external/pi-voice-pack --download

# Verify local source assets and create the single file to transfer to the phone.
npm run speech:export -- --input /external/pi-voice-pack --output /external/english.pivoice
```

On Windows, use absolute paths such as `C:/speech-packs/source` and `C:/speech-packs/english.pivoice`. Existing verified sources can be reused without downloads:

```sh
npm run speech:provision -- --output /external/pi-voice-pack --from-models /external/verified/models
npm run speech:provision -- --output /external/pi-voice-pack
```

The export is a fixed, uncompressed binary format, not an archive. The browser validates its header, exact size and each asset against the installed plugin's compiled manifest. A file cannot supply its own executable code version, model URL or trusted hashes. Re-export when the pinned asset set changes. Preserve provenance/license notices in the source pack and plugin; private export does not resolve redistribution licensing.

Keep large source/export files **outside all installed plugin roots**, including development checkouts installed directly. The pinned host scans more than npm's allowlist when loading a checkout. Prefer the checked tarball for installation.

## TTS pack preparation and playback

ADR 0002's Kokoro runtime and Playback UI are implemented. Use **Prepare cached TTS pack** or **Choose TTS pack** followed by **Import selected TTS pack**. Do not pass it to the recognition importer. Preparation never opens the microphone or speaks; separately enable English Heart playback and tap Speak. Only pinned `af_heart` at normal speed is available, with no OS/cloud/alternate-voice fallback. Unsupported text fails conservatively; full-model TTS, Pixel and host acceptance remain unrun. See [qualification and unresolved license gates](tts-qualification.md).

Preparing TTS releases idle recognition; preparing recognition releases TTS. Only one heavyweight runtime is resident per document. Stop speaking releases TTS resources and requires explicit reprepare. Full off/context/hide revokes playback enablement and instruction allowances. Independent cache inspection/clear controls distinguish cached bytes from initialized readiness. Clear cancels only the selected pack's page-owned use and deletes its exact compiled cache identity, not other packs/revisions, host data or worker ledgers. Other tabs are not canceled. Uncertain capture/playback teardown retains ownership up to five seconds and then latches audio unsafe until reload; cache clear/remount is not recovery.

Existing commands still default to `--pack recognition`, preserving Whisper's `PIVOICE1` format and ordered assets. Explicit `--pack tts` selects the independently pinned `PIVOTTS1` format: 116,019,342 payload bytes plus an eight-byte header (about 116 MB), including its own ORT copy. Acquisition size is not a RAM estimate.

**TTS is import-only.** Download is disabled with an explicit reason: the new
source-built phonemizer has no approved distribution URL. Recognition downloads
remain functional. Old phonemizer bytes are no longer pinned or fetched. The
manifest/cache identity changed; reload the page and re-export/re-import a new
pack. The `PIVOTTS1` format is unchanged. Old cache revisions are not reused or
automatically deleted; old imports fail length/integrity checks.

```sh
# Local, already-verified model/voice files only; no automatic weights download.
npm run speech:provision -- --pack tts --output /external/pi-voice-tts \
  --from-models /external/verified/models --candidate /data/verified-native-build

# Assemble a source handoff now, without model weights or a .pivoice file:
npm run tts:assemble -- --candidate /data/verified-native-build \
  --output /external/tts-source-handoff --dependency-archives /external/dependency-archives \
  --download-dependencies

# With all verified local model/voice/runtime assets, also create english-tts.pivoice:
npm run tts:assemble -- --input /external/pi-voice-tts --candidate /data/verified-native-build \
  --output /external/tts-complete-handoff --dependency-archives /external/dependency-archives
```

`--download-dependencies` acquires only eight lock-integrity-verified public npm
software archives, not model weights; omit it for offline cached assembly.
The full native handoff's binary, source archive, notices and mapping must match
repository pins. `--from-pack` can replace `--from-models` to reuse the compiled
relative asset layout, not a caller-supplied executable manifest. The candidate
handoff is required in either case. TTS `--download` and standalone
`speech:export --pack tts` fail before acquisition/output; use source-aware
assembly instead. Recognition CLI behavior is unchanged.

Assembly preserves exact **uncommitted** application/build/test/docs bytes using
an explicit source allowlist, refuses symlinks/credential-like paths/unexpected
payloads and excludes `.git`, `node_modules`, generated outputs and unrelated
files. It includes concrete dependency package archives and notices, with exact
hashes in `DISTRIBUTION.json` and `DEPENDENCIES.json`. These archives may contain
generated code; preferred/native source completeness (notably ONNX) remains an
explicit review gate, not a claim of complete GPL compliance. A changing
worktree aborts assembly. The browser consumes only compiled pins and pack bytes,
never the producer's informational source manifests.

Keep the entire handoff together. Application original files remain MIT;
linked eSpeak obligations are GPL-3.0-or-later. No assembly flag waives source,
model/voice, device or release-owner review. With no `--input`, the output is a
real engine/application/dependency source handoff but **not** a runnable full TTS
pack. With `--input`, every model/voice/runtime byte and model card is verified
before the handoff is atomically published. See [current evidence](phonemizer-candidate.md).

## Development verification

```sh
npm run verify
npm run test:browser
npm run test:runtime
npm run check:package
npm pack --ignore-scripts
```

`verify` includes strict typechecking, unit/deployment tests and bundling. `test:browser` uses fake media/inference/host in an installed Chromium/Edge browser. `test:runtime` exercises actual pinned ONNX glue/WASM, including its blocked XHR fallback. The package gate sums all packed files' **uncompressed bytes**, not tarball compression, and excludes large speech payloads.

The optional `npm run test:model -- --output /external/pi-voice-pack` uses an existing local verified asset directory, constructs a matching import file, and exercises actual browser inference. It downloads no weights and serves no model route. Synthetic PCM output proves initialization/inference wiring, not speech accuracy or Pixel performance.

The additional TTS checks are separately invoked (no automatic download):

```sh
# Set to the explicit external source-built production phonemizer file.
VOICE_TTS_PHONEMIZER_FILE=/external/phonemizer.js npm run test:tts-runtime
VOICE_TTS_PHONEMIZER_FILE=/external/phonemizer.js npm run test:tts-phonemizer
# Set to an explicit external, verified PIVOTTS1 import file.
VOICE_TTS_PACK_FILE=/external/english-tts.pivoice npm run test:tts-model
```

Set the corresponding environment variables using your shell's syntax on Windows. The loader check exercises real phonemizer/ORT without model weights; the model check requires operator-provided weights and remains unrun. Neither establishes Pixel performance or intelligibility. Do not fetch weights to make default tests pass.

Reload the full page when upgrading from OS-synthesis builds; do not hot-swap controllers while legacy audio may exist.

## Remaining real-device gates

Actual Pixel 8 timing, accuracy, memory/heat/battery, file-picker behavior, cache quota/eviction, authenticated host CSP, microphone/headset behavior and actual Kokoro intelligibility, offline/cache-only behavior and device-level network privacy require acceptance on the device. No locked-screen, background audio or driving guarantee is made. Direct-download CORS/source availability must be checked separately from offline import/inference tests.

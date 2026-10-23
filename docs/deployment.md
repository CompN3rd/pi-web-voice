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

ADR 0002's Kokoro runtime and Playback UI are implemented. Use **Prepare cached TTS pack**, **Download pinned TTS pack**, or **Choose TTS pack** followed by **Import selected TTS pack**. Do not pass it to the recognition importer. Preparation never opens the microphone or speaks; separately enable English Heart playback and tap Speak. Only pinned `af_heart` at normal speed is available, with no OS/cloud/alternate-voice fallback. Unsupported text fails conservatively; full-model TTS, Pixel and host acceptance remain unrun. See [qualification and unresolved license gates](tts-qualification.md).

Preparing TTS releases idle recognition; preparing recognition releases TTS. Only one heavyweight runtime is resident per document. Stop speaking releases TTS resources and requires explicit reprepare. Full off/context/hide revokes playback enablement and instruction allowances. Independent cache inspection/clear controls distinguish cached bytes from initialized readiness. Clear cancels only the selected pack's page-owned use and deletes its exact compiled cache identity, not other packs/revisions, host data or worker ledgers. Other tabs are not canceled. Uncertain capture/playback teardown retains ownership up to five seconds and then latches audio unsafe until reload; cache clear/remount is not recovery.

Existing commands still default to `--pack recognition`, preserving Whisper's `PIVOICE1` format and ordered assets. Explicit `--pack tts` selects the independently pinned `PIVOTTS1` format: 115,849,893 payload bytes plus an eight-byte header (about 116 MB), including its own ORT copy. Acquisition size is not a RAM estimate.

```sh
# Optional operator opt-in; never run automatically by build or tests.
npm run speech:provision -- --pack tts --output /external/pi-voice-tts --download
npm run speech:export -- --pack tts --input /external/pi-voice-tts --output /external/english-tts.pivoice

# Alternatively reuse verified complete source assets without downloading.
npm run speech:provision -- --pack tts --output /external/pi-voice-tts --from-pack /external/verified-tts
```

`--from-pack` accepts a directory with the compiled relative layout (model, voice, phonemizer and runtime), not a caller-provided manifest. Missing/corrupt files fail without `--download`; existing verified entries remain reusable. `--from-models` remains supported for the older model-directory layout. Do not combine both source options.

Keep the source directory's model card, provenance, published phonemizer license and `TTS-QUALIFICATION.md` alongside any privately exported file. The embedded eSpeak-derived runtime's native corresponding-source provenance and combined GPL obligations are unresolved and block release/conveyance; `private: true` is not an exemption when code/assets are sent to others. This tooling is not permission to distribute/release the candidate. No weights are bundled into the plugin.

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
# Set to an explicit external published phonemizer@1.2.1 file.
VOICE_TTS_PHONEMIZER_FILE=/external/phonemizer.js npm run test:tts-runtime
VOICE_TTS_PHONEMIZER_FILE=/external/phonemizer.js npm run test:tts-phonemizer
# Set to an explicit external, verified PIVOTTS1 import file.
VOICE_TTS_PACK_FILE=/external/english-tts.pivoice npm run test:tts-model
```

Set the corresponding environment variables using your shell's syntax on Windows. The loader check exercises real phonemizer/ORT without model weights; the model check requires operator-provided weights and remains unrun. Neither establishes Pixel performance or intelligibility. Do not fetch weights to make default tests pass.

Reload the full page when upgrading from OS-synthesis builds; do not hot-swap controllers while legacy audio may exist.

## Remaining real-device gates

Actual Pixel 8 timing, accuracy, memory/heat/battery, file-picker behavior, cache quota/eviction, authenticated host CSP, microphone/headset behavior and actual Kokoro intelligibility, offline/cache-only behavior and device-level network privacy require acceptance on the device. No locked-screen, background audio or driving guarantee is made. Direct-download CORS/source availability must be checked separately from offline import/inference tests.

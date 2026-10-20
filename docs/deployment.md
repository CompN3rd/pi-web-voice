# Plugin installation and browser speech packs

The plugin requires **no additional host route, reverse-proxy mapping or inference service**. [ADR 0001](adr/0001-browser-owned-speech-pack-acquisition.md) supersedes the earlier `/pi-voice-speech/` static-route design. Do not configure that route for this version.

## What is installed

The normal Pi package contains the panel, recognition worker/worklet JavaScript, text backend/companion, notices and pinned speech-asset metadata. Keep it below Pi Web's pinned **16 MiB total uncompressed artifact** limit. Model weights and the large WASM file are acquired by the browser separately and do not belong in the installed package directory.

Use the normal Pi package installation flow after explicit authorization. Enable the plugin and its companion as described in README. New server-plugin activation still requires an authorized daemon restart outside hosted sessions; this interrupts active sessions. Nothing in the build/acquisition tools performs live activation or restarts.

## First use on the phone

Open Pi Web through its existing secure HTTPS deployment, open Local voice and choose an acquisition method:

- **Cached preparation:** verify the existing browser speech cache and initialize recognition. No model download is permitted. Use this after a previous successful import/download.
- **Explicit download:** consent to roughly 65 MB of pinned public model/runtime downloads from Hugging Face and its CDN, and jsDelivr. No API key or separately billed inference service is involved. Requests omit credentials/referrer; the distribution hosts still see normal request metadata. Every file must pass compiled size/hash checks.
- **File import:** select a matching `.pivoice` file from the phone's Files picker. Import is local and does not contact model-distribution hosts. This is the alternative when direct downloads are blocked by CORS, connectivity or the existing host policy; no proxy-route workaround is required.

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

## Development verification

```sh
npm run verify
npm run test:browser
npm run test:runtime
npm run check:package
npm pack --ignore-scripts
```

`verify` includes strict typechecking, unit/deployment tests and bundling. `test:browser` uses fake media/inference/host in an installed Chromium/Edge browser. `test:runtime` exercises actual pinned ONNX glue/WASM, including its blocked XHR fallback. The package gate sums all packed files' **uncompressed bytes**, not tarball compression, and excludes large speech payloads.

The optional `test:model` uses an existing local verified pack and actual browser inference; consult its command help/current implementation for the input option. It must not download weights automatically or require a model-serving host route. Synthetic PCM output proves initialization/inference wiring, not speech accuracy or Pixel performance.

## Remaining real-device gates

Actual Pixel 8 timing, accuracy, memory/heat/battery, file-picker behavior, cache quota/eviction, authenticated host CSP, microphone/headset behavior and Android local-voice airplane-mode/network behavior require acceptance on the device. No locked-screen, background audio or driving guarantee is made. Direct-download CORS/source availability must be checked separately from offline import/inference tests.

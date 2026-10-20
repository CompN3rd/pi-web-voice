# External speech-pack deployment (experimental)

This deployment contract supersedes older plugin-relative speech-path descriptions in the design/README. No live host configuration, activation, installation or daemon restart is performed by these commands. Pixel, real microphone, accuracy, authenticated live-host and release/license acceptance remain separate gates.

## Two artifacts, one browser origin

Pinned Pi Web `1.202610.3` limits **the total uncompressed plugin package** to 16 MiB (and 4096 artifact entries), not each individual file or the compressed tarball. Its scanner excludes `.git` and `node_modules`, but scans other files in an installed checkout. Putting the roughly 65 MB model/runtime pack anywhere under that install root fails admission, even if it is outside `browserRoot` or excluded from npm's file list.

1. **Plugin package:** bundled browser/controller/worker/worklet JavaScript, server/companion, notices/provenance and documentation. Build hashes the matching pinned runtime without copying its glue/WASM or model files into browser assets. It removes only the old generated `dist/browser/speech/models` and `dist/browser/speech/ort` trees in this worktree, then restores runtime notices. It does not touch an external pack.
2. **External speech pack:** model, matching runtime glue/WASM and notices, stored **outside every installed package/checkout root**, published by the operator at the fixed same-origin HTTPS path **`/pi-voice-speech/`**. This is an explicit static-server/reverse-proxy mapping, **not an existing or private Pi Web route**. There is no arbitrary remote URL setting, CDN, audio transport or provider credential.

The worker uses `new URL('/pi-voice-speech/', import.meta.url)`, so a nested plugin module still loads assets from that origin's fixed root path. Explicit browser preparation fetches only manifest-listed files with same-origin credentials, rejects redirects and checks exact lengths/SHA-256. Subsequent runtime access remains verified/cache-only; cache loss/corruption fails closed, including ORT's XHR fallback. No audio is uploaded.

## Build and provision

Node 24+, pinned lockfile dependencies, no install lifecycle downloads:

```sh
npm ci --ignore-scripts
npm run verify
npm run test:browser
npm run test:runtime
npm run check:package
```

`build`/`verify` enforce a generated-browser size/payload gate; `check:package` independently runs `npm pack --dry-run --json --ignore-scripts` and verifies the **sum of every packed file's bytes <= 16777216**, with no model tree, ONNX weights, standalone ORT runtime glue or WASM. There is no compressed-size shortcut. Run the package gate again after any changes. Prefer installing a deliberately created `npm pack --ignore-scripts` tarball, extracted into a clean install root: it excludes development scratch files that a checkout's host scan would otherwise include. Do not leave the tarball, external pack or other large unrelated files inside an installed checkout. Packing is not authorization to install/activate/publish.

Provisioning always requires an absolute output directory. Paths inside this package/repository, symlink aliases into it, and existing symlink children are rejected. Keep the destination operator-owned and do not change its directory links concurrently while provisioning. Choose a dedicated path outside **all** other plugin installations too.

```sh
# Explicit network opt-in: pinned public model downloads; no credentials.
npm run speech:provision -- --output /srv/pi-voice-speech --download

# Offline reuse: source is the directory containing onnx-community/whisper-tiny.en.
# Source is read-only; every source file must match the pinned manifest.
npm run speech:provision -- --output /srv/pi-voice-speech --from-models /external/verified/models

# Recheck/reuse an already complete output; missing/corrupt models fail without download.
npm run speech:provision -- --output /srv/pi-voice-speech
```

On Windows use an absolute path such as `C:/speech-packs/pi-voice-speech`. Runtime files always come from the pinned local npm dependency, with dependency-version checks, and receive the same hashes embedded by build. Model files are hash/length verified before writing, including reuse. `--download` is never implied by build, install, tests or package hooks. Output includes `speech-assets.json`, provenance, model card, Transformers license and ONNX Runtime license. The converted-model license-label discrepancy remains unresolved; retained notices do not constitute redistribution approval.

Build and provision with the **same lockfile/runtime versions**. Stage a complete verified pack before operator publication; do not mix revisions during active preparation. Browser cache is not a substitute for a deployment pack. Updates may require coordinating active clients, which can fail closed if served a different pinned revision.

## Explicit reverse-proxy/static mapping

Illustrative **operator-applied** nginx location on the same HTTPS virtual host that already serves Pi Web:

```nginx
location ^~ /pi-voice-speech/ {
    alias /srv/pi-voice-speech/;
    autoindex off;
    types {
        application/wasm wasm;
        text/javascript mjs;
        application/json json;
    }
    default_type application/octet-stream;
    add_header X-Content-Type-Options nosniff;
    # Apply the deployment's existing access-control/auth policy here too.
    # Do NOT proxy this location to an assumed Pi Web plugin/session endpoint.
}
```

This is a mapping example, not a complete auth/TLS configuration. The operator must integrate the existing same-origin authentication/access policy (including cookie path coverage), TLS and read-only filesystem permissions. Same-origin fetch sends existing session cookies; do not inject long-lived secrets or place credentials in asset URLs. Decide deliberately whether static model files are publicly readable or protected; Pi authentication is **not automatically applied** merely because an nginx alias exists. If protected, unauthenticated requests should fail instead of redirecting to an HTML login page. Asset requests must return the actual bytes with success status and no redirects. No CORS/CDN is needed. Confirm `/pi-voice-speech/ort/ort-wasm-simd-threaded.jsep.wasm` resolves from the authenticated browser origin independently of the plugin's nested asset path.

Host CSP must permit same-origin worker and asset loading plus verified runtime blob imports and WASM compilation: typically `worker-src 'self' blob:`, `script-src 'self' blob: 'wasm-unsafe-eval'`, and `connect-src 'self'`, merged into the host's actual policy. Include appropriate JavaScript/WASM MIME types and any CSP headers served on the worker itself. Do not broadly enable arbitrary remote origins or general `'unsafe-eval'` to bypass a deployment problem. Single-thread WASM does not require shared-memory cross-origin isolation. The exact host/browser policy needs independent HTTPS acceptance; a loopback fixture does not prove it.

## Optional actual-model browser smoke

After provisioning, using installed Edge/Chromium (set `VOICE_BROWSER_EXECUTABLE` if needed):

```sh
npm run test:model -- --output /srv/pi-voice-speech
```

This builds production code, verifies the external files, starts only an ephemeral **loopback test fixture**, and serves the nested worker and `/pi-voice-speech/` separately. No live daemon is contacted or restarted. No microphone permission is requested. The real q8 pipeline prepares, then transcribes one second of synthetic 220 Hz PCM while all further HTTP is blocked. It asserts **zero attempted and received HTTP requests during inference**. Output text is not asserted or presented as accuracy evidence. No audio/model download is performed; absent packs fail. Default `test:runtime` needs no model weights and retains actual ORT glue/WASM cached/evicted/corrupt and native-XHR-bypass regression coverage at the external path.

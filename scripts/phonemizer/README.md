# Source-built English phonemizer candidate

This builds **a new candidate**, not a reconstruction of `phonemizer@1.2.1`.
Native source: eSpeak NG 1.52.0, commit
`4870adfa25b1a32b4361592f1be8a40337c58d6c`. Exact archive URLs/SHA-256,
Emscripten 3.1.74 compiler revision/build and Node 22.16.0 are in `pins.json`.
Only public pinned archives are used. No native compiler, CMake, SDK activation,
system install, model weights or provider requests are needed.

## Build (Linux x86_64, Python 3.12+)

Run from the repository:

```sh
python3 scripts/phonemizer/build.py \
  --output /data/voice-phonemizer-build-1 \
  --downloads /data/voice-phonemizer-downloads --download
```

Remove `--download` for a build using already-present, hash-checked archives.
The output must be new/empty, outside this source tree; existing files are not
deleted. Downloads/toolchain/cache/compiler temporaries stay under explicit
external `/data` paths. No environment activation or host service is changed.
Subprocesses receive an explicit environment allowlist (fixed system Python PATH,
external HOME/TMP/cache, pinned EM_CONFIG); no inherited SDK/compiler/runtime or
Python/loader override can replace the pinned tools. Run `python3 -B
scripts/phonemizer/test_build.py` for the environment regression.
The script rejects non-Linux/x86_64 hosts and archive hash mismatches before
executing any downloaded tool. Python and the host Linux ABI are prerequisites,
recorded in `build-record.json`, not claimed hermetically pinned.

Output:

- `phonemizer.mjs`: self-contained ES module; WASM and data embedded. Public
  `phonemize(text, "en-us") -> Promise<string[]>` matches `EnglishPhonemizer`.
  Initialization is lazy, shared and failure-sticky; calls cannot interleave
  native state. Empty input returns `[]`; other languages, NUL and inputs over
  1,000 UTF-16 units reject. Production text/token preflight remains necessary.
- `SOURCE.json`: binary/source archive/notices hashes, all archive pins, builder
  inputs and individual embedded data hashes/source mapping.
- `source.tar.gz`: full unmodified native source archive (including all native
  licenses and data attribution), original bridge/wrapper/config/build recipe,
  Emscripten embedded-runtime preferred source (`src` and `system`, retaining
  in-tree licenses), notices and build record. Extract and use
  `source/builder/build.py --downloads /data/new-cache --output /data/new-build
  --download` to rebuild; optionally copy `source/inputs/espeak-ng.tar.gz` into
  that cache first. General-purpose pinned compiler/Node binaries are not in
  this source archive; their exact publicly retrievable archives are pinned.
- `NOTICES.txt`, `build-record.json`, `build.log`, and intermediate `work/`.
  Do not ship `work/` or a lone executable as the distribution format.

The native tree is not patched. `config.h` disables async/audio-device/optional
synthesizer libraries; `-include wchar.h` orders musl declarations before native
Unicode macro remaps. The explicit source list follows native CMake source
lists, but no CMake dependency fetching occurs. The offline dictionary compiler
is itself built to WASM with the same compiler and runs under pinned Node.
**Only that build-time CLI uses NODERAWFS.** The browser candidate has only
Emscripten memory filesystem; it embeds compiled base phoneme/intonation tables,
English dictionary (`en_rules`, `en_list`, `en_emoji`), and unchanged `en`/`en-US`
voice definitions. Shared base phoneme tables include other languages' tables,
but no non-English dictionary or alternate language API is exposed.

The browser links no audio output interface, creates no nested workers and
needs no external data fetch or decompression. Memory/worker lifecycle remains
owned by the caller. The compiler may retain unreachable generic transport
helpers; guarded browser execution, not grep alone, establishes the tested
network boundary. This is text-to-IPA only, not speech/audio qualification.

## Licensing and distribution boundary

Original bridge/wrapper/build files retain MIT (adjacent `LICENSE`). eSpeak NG
and its Unicode tools retain **GPL-3.0-or-later**; the linked candidate is not
relabelled MIT/Apache. Native source has additional component/data notices;
keep the complete source tree and supplied notices. Embedded Emscripten runtime
and libc/compiler-support code retain their own permissive notices, including
Emscripten MIT/NCSA, musl and LLVM notices. Preserving broader runtime source
and notices is conservative, not a statement that every source file is linked.

`SOURCE.json` plus adjacent binary, source archive and notices is a concrete
candidate handoff, **not approval to convey the complete application**. GPLv3
§1/§6(d) corresponding source/delivery must be assessed for the actual combined
work and recipients. A worker/module boundary does not grant a GPL exception.
A later application distribution also needs application/dependency sources,
appropriate legal notices/source access and owner-reviewed delivery terms; an
engine-only archive is not that complete combined-work distribution. Original
project licenses and package `private: true` remain unchanged.

This builder does not mutate an application's manifest, deploy or publish.
Its `productionIntegrated: false` mapping describes that producer boundary,
not an application's current manifest. The integrating Pi Web Voice application
now pins the measured module for **import-only** TTS with a new cache identity;
old pack bytes are incompatible. The module alone is not a `.pivoice` pack.
Application-level source-aware assembly, complete combined-source review,
full-model regression, device qualification and release-owner review remain
separate requirements. No approved download URL or live deployment is implied.

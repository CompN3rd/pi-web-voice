# Licensing and redistribution audit

## Outcome

**Notice remediation completed; a new source-built phonemizer now replaces the production pin, with import-only acquisition, source-aware assembly and browser tests; executable TTS-pack redistribution is NOT cleared.** See [candidate evidence](phonemizer-candidate.md) for the concrete resolution milestone. This is a technical artifact/provenance audit, not legal advice or an infringement finding. `private: true`, the prototype release test and publication gate remain in place. The original audit downloaded no model weights and produced no speech binary, tarball release or npm publication. The subsequent resolution milestone built an external native candidate and source archive, but did not deploy/publish them or rewrite history.

## Audited boundary and evidence

Baseline: commit `2ce445899a33ff7de3ec9a92d9ec3341180321df` and all locally reachable refs, checked against the remote heads/tags. GitHub visibility was confirmed PUBLIC; there were no GitHub releases listed. The seven remote feature branches and main were represented locally. `git rev-list --all` covered **31 commits / 209 unique reachable blobs**. No tracked `dist/`, `node_modules/`, `.wasm`, `.onnx`, `.bin`, `.pivoice`, `.tgz`, `.zip` or `.data` artifacts appeared. All blobs decoded as UTF-8 with no NUL bytes; selected embedded WASM/base64 markers also produced no matches. Largest blob: 167,019-byte package lockfile.

This is evidence that these reachable Git refs do not contain the speech/runtime binary distribution, not proof about deleted refs, unreachable objects, forks, Actions artifacts, historical external uploads or actual recipients. Small copied third-party tokenizer fixtures and license texts do exist in the source tree and were inspected. No secret/credential stores were read.

Generated package review used esbuild metadata and `npm pack --dry-run --json --ignore-scripts`. Actual bundled JavaScript packages are:

| Package | Pinned version | Declared terms |
| --- | --- | --- |
| lit | 3.3.3 | BSD-3-Clause |
| lit-html | 3.3.3 | BSD-3-Clause |
| lit-element | 4.2.2 | BSD-3-Clause |
| @lit/reactive-element | 2.1.2 | BSD-3-Clause |
| @huggingface/transformers | 3.8.1 | Apache-2.0 |
| onnxruntime-web | 1.22.0-dev.20250409-89f8206ba4 | MIT plus third-party notices |
| onnxruntime-common | 1.21.0 | MIT |
| @jmfederico/pi-web | 1.202610.3 | MIT |

The direct-input table is not exhaustive of upstream prebundles: the later
[source inspection](dependency-sources.md) identifies embedded MIT
`@huggingface/jinja@0.5.3` in Transformers and now preserves its complete notice
and full source/build archive. ORT web also embeds common sources at its own
native revision, distinct from direct common 1.21.0.

The companion's external host dependencies are not bundled into it. This inventory is not a full transitive-development SBOM. In particular, including ONNX's complete upstream third-party notice is conservative preservation, not a determination of precisely which native components the WASM contains.

## Fixed gaps

1. Builds now validate actual esbuild input installations (including nested dependency paths), reject unknown bundled dependencies or changed reviewed versions/license metadata, and generate **complete** bundled license text in `dist/THIRD_PARTY_NOTICES.txt`. The full reviewed notice inventory is preserved on partial speech builds too, including retained UI/server output. That file and `THIRD_PARTY.md` are included in npm's allowlist. This closes the omitted standalone Lit/Pi Web notice inventory without stripping existing inline legal comments.
2. ONNX Runtime's full upstream `ThirdPartyNotices.txt` from the pinned native commit is retained verbatim and copied beside each pack's ORT license. Integrity is regression-tested. The source/hashes are in `THIRD_PARTY.md`.
3. OpenAI's Whisper MIT text is retained and copied into recognition notices. Source: [Whisper LICENSE at 86098128c0b4f24f0e2aa2994de830614b474227](https://github.com/openai/whisper/blob/86098128c0b4f24f0e2aa2994de830614b474227/LICENSE). This preserves upstream terms; it does not independently settle the converted-artifact provenance below.
4. Tokenizer fixture attribution now names the immutable source, unchanged-copy status, declared Apache-2.0 terms and retained full license text. Root MIT coverage is explicitly limited to original contributions rather than all third-party material.

## External provenance findings

### Retired published phonemizer / eSpeak — historical hard blocker

- `phonemizer@1.2.1` is pinned to wrapper commit [`6835144b7ee9043129222549c1ed2f6a27216278`](https://github.com/xenova/phonemizer.js/tree/6835144b7ee9043129222549c1ed2f6a27216278). Its README identifies eSpeak NG. Its tree includes generated `src/espeakng.worker.js` and `data/espeakng.worker.data` plus wrapper/Rollup sources, but does not establish the exact native source, dictionary inputs, patches and toolchain used for those generated artifacts.
- [Upstream issue #6](https://github.com/xenova/phonemizer.js/issues/6), “Invalid license”, was still open when inspected. Its existing comment asks for this exact source/build information. No response supplying it was present. No comment or issue was posted during this audit.
- At the original audit boundary, the candidate eSpeak reference did not establish corresponding source for the published binary. The subsequent source-built replacement has its own verified pins and source handoff; it does not retrospectively qualify that retired binary.
- GPLv3 defines Corresponding Source in §1 and network object-code/source conveyance in §6(d): [license text](https://www.gnu.org/licenses/gpl-3.0.html). The distribution design must account for the actual covered work and recipients. A separate worker, dynamic import or external pack is not automatically a copyleft exemption; nor does it establish that every backend file must be relicensed.

### Kokoro model / voice — better documented, not independently cleared

The exact [converted model card](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/blob/1939ad2a8e416c0acfeecc08a694d14ef25f2231/README.md) declares Apache-2.0. Upstream [Kokoro README at f3ff3571791e39611d31c381e3a41a3af07b4987](https://huggingface.co/hexgrad/Kokoro-82M/blob/f3ff3571791e39611d31c381e3a41a3af07b4987/README.md) expressly describes Apache-licensed weights and permissive/non-copyrighted training data, and separately acknowledges Koniwa CC BY 3.0 and SIWIS CC BY 4.0 training material. The same source demonstrates `af_heart`; [VOICES.md](https://huggingface.co/hexgrad/Kokoro-82M/blob/f3ff3571791e39611d31c381e3a41a3af07b4987/VOICES.md) identifies voices.

These are meaningful publisher representations, not evidence of a discovered voice prohibition. This audit has not independently traced the pinned converted `af_heart.bin` to all underlying rights or established the applicable attribution chain. Retain upstream cards/acknowledgements and have the release owner assess whether the publisher evidence is sufficient; do not invent a requirement that all training data be republished, or assert that training-data licenses automatically become the model's license.

### Whisper — preserve both provenance layers

The pinned [converted card](https://huggingface.co/onnx-community/whisper-tiny.en/blob/2575352d61be1bf7225cf8f8b268a4678025fc58/README.md) references OpenAI but contains no explicit license frontmatter. The [base HF card](https://huggingface.co/openai/whisper-tiny.en/blob/87c7102498dcde7456f24cfd30239ca606ed9063/README.md) declares Apache-2.0, while OpenAI's GitHub LICENSE is MIT. Both are permissive licenses; different labels alone do not establish incompatibility. Preserve the OpenAI text and HF provenance, and resolve the exact converted/tokenizer attribution before shipping a recognition pack. Existing qualification is not silently waived.

## Chosen route to close the hard blocker

**Prefer a controlled new eSpeak build over guessing the old binary's origin.** Do not switch to an unqualified alternative or silently remove local speech.

1. Pin a reviewed eSpeak source revision, English dictionary/data inputs and wrapper source. Record patches, full source licenses/notices, Emscripten/toolchain versions/options and commands.
2. Build a **new candidate** from those inputs. Do not call it a reproduction of `phonemizer@1.2.1`. Keep the browser-local `TtsLoader.phonemize` / `EnglishPhonemizer` contract.
3. Assemble a source/build distribution with explicit binary hashes and source correspondence, using a reviewed GPL-compliant delivery arrangement. The current `.pivoice` exporter only emits asset bytes; adjacent notices alone are not a corresponding-source distribution. Reproducibility is useful evidence, not the entirety of the legal requirement.
4. Obtain a combined-work licensing decision before choosing distribution metadata. Do not simply change the entire project's MIT license or treat worker isolation as an exception.
5. Update `scripts/tts-pack.json` **and** `src/browser/speech-assets.ts` distribution policy. Changed bytes require new pins/cache identity and re-export/reacquisition documentation.
6. Requalify phonemizer/token fidelity, guarded startup, cancellation, transport refusal, actual model output and Pixel behavior. Source provenance does not establish model correctness or device acceptance.

The subsequent [source-built replacement milestone](phonemizer-candidate.md) implements steps 1–2 and 5, an engine/application/dependency artifact handoff for step 3, and real guarded-browser/tokenizer checks for part of step 6. The later [preferred-source resolution](dependency-sources.md) adds full immutable upstream sources/build files for all eight directly bundled dependencies, separately identifies embedded Jinja 0.5.3 and pins native build declarations. Exact native binary correspondence and recursive native-source closure remain open; assembly is not combined-work license clearance. It does not close the combined-application delivery decision, full-model or device gates. The unknown old binary is not retroactively qualified and is no longer selected by production. No repository-wide relabeling or speculative production substitution was made. An MIT/Apache wrapper around another engine is not sufficient evidence.

## Validation and release posture

Historical validation at the initial audit-remediation boundary: `npm run verify` (172 unit/contract tests plus 22 asset/release/notice tests), `npm run test:browser` (151 checks with an installed Chromium executable), `npm run test:runtime` (cached/evicted/corrupt scenarios), and `npm run check:package` pass. The available local runtime is Node 22.22.2; That local run did not establish Node 24 validation; subsequent milestone/CI evidence is separate. Notice tests cover package detection, complete retained license text, upstream notice integrity and packaging entries; existing tests cover speech hashes and external-payload exclusion. Passing checks demonstrate packaging mechanics, not legal clearance.

The public source repository and an executable pack are distinct distributions. Nothing found in the inspected reachable history establishes a need to rewrite it, but this is not a universal legal clearance. Release/conveyance of the unqualified TTS pack remains blocked; do not publish by merely changing `private` or copying another license file.

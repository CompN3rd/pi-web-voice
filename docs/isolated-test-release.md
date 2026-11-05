# Isolated test release and actual installed-host acceptance

## Executed result

A private local test package was installed and exercised on a **real, separately
running Pi Web 1.202610.3 / Pi 1.2.0 host**, using portable Node **24.22.2** and
Chromium **156.0.8078.4**. This was not a public npm/GitHub release, not activation
in the hosting instance, and not a claim of Pixel or listening acceptance.

Tested tarball:

- `/data/pi-web-voice-model-tests/release-candidate/compn3rd-pi-web-voice-0.1.0.tgz`
- 895,367 bytes; 41 packed files; 5,503,152 uncompressed bytes.
- SHA-256: `2e8fc30276365e962cc02a68fe17767b65d3b5892db3934cecbb994e19e2f971`.
- `private: true` and `defaultEnabled: false` retained.

The candidate contains the reviewed 128-token synthesis change and CI test-race
fix. The final transcript-comparison test correction and this acceptance report
were added after that package was made; neither changes its production payload.
The exact tested artifact identity above, not a newly rebuilt tarball's identity,
is the installed-host evidence reference.

## Isolation and install

All new host runtime dependencies, configuration, project, profile, sessions and
logs were placed under `/data/pi-web-voice-acceptance/`. The host was installed
from the project's lockfile into its separate `runtime/`; only that copy's
`node-pty` native module was rebuilt for Node 24. No global runtime was modified.

The launcher used an explicit environment instead of inheriting the live
instance's `PI_WEB_*` values or provider credentials:

- Loopback web address `127.0.0.1:18764` and fixture provider `127.0.0.1:18765`.
- Own `PI_WEB_DATA_DIR`, `PI_WEB_CONFIG`, `PI_WEB_SESSIOND_SOCKET`,
  `PI_CODING_AGENT_DIR`, `PI_CODING_AGENT_SESSION_DIR`, HOME and XDG config.
- Offline model catalogs/update checks; no paid provider or existing login.
- The public `pi-web-server` / `pi-web-sessiond` package entrypoints, no private
  host route imports or direct database access.

The tarball hash was verified before safe extraction into an external install
folder. The extracted package was registered using the pinned public
`pi install <local-package-directory>` CLI in the fresh profile—not merely a
web-plugin symlink. Voice was enabled only in this test host's configuration.
The test project was registered through the real browser's **Add Project** UI.
Only the test instance was started/restarted. At the end, the web process,
session daemon and fixture provider were stopped by recorded PID after checking
their exact executable/entrypoint against the sandbox; there were no broad
process kills or service-manager operations.

## Installed worker workflow: passed

The coding-model transport was an explicitly labelled deterministic loopback
OpenAI-compatible fixture. **It was not a real coding-model quality test.**
The web host, browser plugin, server plugin, Pi session machinery and companion
were real and loaded from the package/profile.

1. Packaged browser entry mounted on the pinned host.
2. Proposing an instruction did not admit it before separate exact approval.
3. Approval created a normal worker session; the companion settled its response.
4. Explicit Read retrieved the saved result.
5. A real companion `voice_request_input` tool call produced a question in the
   attention inbox.
6. Review and reply selected the exact worker; an approved answer continued it
   and produced its result.
7. Workers survived page/panel reload without creating replacement workers.

No external browser request or browser page error was observed.

## Installed speech workflow: passed

Both production packs were imported through the **actual file chooser and
explicit Import controls** into the installed panel. Actual Whisper, Kokoro,
eSpeak and ONNX runtime code ran in their production browser workers. The
pack/source hashes are recorded in
`/data/pi-web-voice-model-tests/handoff.json` and `model-validation.md`.

A deterministic fake microphone used a WAV generated from the actual Kokoro
sentence `Hello world. This is local English speech.`. This exercises Chromium's
capture, the real audio worklet/resampler and Whisper, without recording a
person or persisting user microphone audio. It does not test physical microphone,
headset or Android picker behavior.

| Observation | Result |
| --- | --- |
| Recognition import/init | 6,513 ms; no microphone opened during preparation |
| Capture/transcription | `Hello World, this is Local English Speech.` |
| Finish-to-transcript | 6,240 ms |
| Capture ownership | One native fake-media track; ended after Finish |
| Dispatch | No provider call caused by recognition or speech playback |
| TTS import/init | 8,641 ms; typed transcript retained during runtime handoff |
| Playback authority | Still disabled after preparation; explicitly enabled before Speak |
| Selected result playback | Actual Kokoro synthesis and native Web Audio completion, 38,065 ms |
| Voice off | Playback enablement revoked; workers retained |
| Network/errors | Zero external browser requests; zero page errors |

The TTS result was a short fixture response with the plugin's real workspace/
worker introduction. Headless Web Audio completion establishes the playback
pipeline, **not human-perceived intelligibility or speaker/headset quality**.
The observed synthesis latency is slow and must not be marketed as conversational
or Pixel-qualified. Original long model fixtures still hit the unchanged bounded
job deadline and are recorded as timeout/fail-closed outcomes, not successful
complete playback; see `model-validation.md`.

## Independent review and regression correction

Review accepted the smaller no-truncation chunks, unchanged PCM/time ceilings,
CI mutation-test isolation, and separation of successful versus timed-out model
fixtures. It found the round-trip assertion removed digits/non-ASCII letters in
addition to punctuation. A shared test normalizer now preserves those characters,
with negative regressions for added digits, Unicode letters and symbols. The
recorded transcript itself already matched; the corrected comparison was rerun
against the actual model rather than merely loosening the test (5,284 ms for the
known synthetic sentence, zero inference HTTP attempts).

Parent final verification passed **174 unit tests, 39 asset tests, 151 fake-model
browser checks**, strict typecheck/build, and all three real recognition-runtime
cache/corruption scenarios. These deterministic suites remain distinct from the
installed-host and actual-model evidence above.

## Retained evidence and limits

Under `/data/pi-web-voice-acceptance/`:

- `logs/package-acceptance.json` and `package-acceptance.png`: seven real-host
  worker checks.
- `logs/speech-acceptance.json` and `speech-acceptance.png`: real installed speech
  timings, exact synthetic transcript, lifecycle/no-dispatch observations.
- `start-host.mjs`, `stop-host.mjs`, `test-package.mjs`, `test-speech.mjs` and the
  local provider fixture: run-specific acceptance harness, using public UI/CLI.
- `processes-stopped-*.json`: owned-process shutdown records.

These scripts contain this run's external paths and host-assigned IDs; they are
retained evidence, not advertised as a portable CI command. No real user audio,
provider credential, paid API request, public release tag, production activation
or hosting-daemon restart was used. The vision document is unchanged.

Physical Pixel/listening tests and public redistribution/release approval remain
separate from this completed local test-release milestone. Existing licensing
source-completeness limitations are documented, not waived by a successful run.

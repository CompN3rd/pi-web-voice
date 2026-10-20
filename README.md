# Pi Web Voice

Experimental **native-audio voice cockpit** for `@jmfederico/pi-web`: talk to OpenAI Realtime in the browser, delegate text tasks to ordinary Pi conversations, and hear worker status/results. The audio model and worker models are independent. No browser SpeechRecognition, external transcription vendor, or separate TTS service is used.

**Status: local prototype, not a released or driving-validated product.** The repository is registered in Pi Web; the plugin is not installed/activated in the live daemon. No live provider calls or real microphone/device acceptance tests have been performed. See [validation](docs/validation.md), [research/design](docs/design.md), and [security](docs/security.md).

## Implemented

- Workspace-scoped Voice tab; explicit microphone activation, mute/resume, stop-speaking and disconnect controls.
- OpenAI Realtime WebRTC audio in/out; semantic turn detection by default, configurable silence-based VAD, provider-managed barge-in.
- Server-side API key and SDP exchange through the paired plugin transport. No long-lived provider credential reaches the browser.
- Text worker creation with any available Pi model by exact `provider/model-id`; optional catalog from an already-hosted selected conversation. Omitting the model uses the new session's Pi default, **not the selected conversation's model**.
- Default review-before-send task proposals; optional server-enforced allowance for three instructions within ten minutes. Follow-ups count too.
- Durable worker ledger, exact IDs, request deduplication, revisions, sequenced companion snapshots and conservative `unknown` outcomes. Workers survive panel closure; voice does not own or cancel them.
- Five-second status polling while the panel is mounted; short spoken status alerts while connected. Explicit `read_worker` shares a bounded result/question with OpenAI for spoken feedback.
- A companion `voice_request_input` tool ends the worker turn with a saved question. A normal, approved text follow-up answers it.
- Text fallback, full-session navigation, escaped result rendering, foreground screen wake-lock request where supported.

## Important limits

- **Not always-on Siri.** One initial tap and browser microphone permission are required. No wake-word engine is included. Muting does not leave a local wake detector running: tap Resume. Hiding the page, changing machine/workspace, closing the panel, losing transport, or reaching 25 minutes disconnects audio and revokes the allowance. Do not depend on this while driving; configure and test while parked.
- Only the **currently selected workspace** is controlled. Switching projects/workspaces by voice is not implemented. Public v5 catalogs are a future upgrade, not an excuse to call private host routes.
- **Not every Pi question is bridged.** Core `ask_user`, other extensions' permission dialogs and ordinary prose questions still require the normal conversation UI. A settled turn is not independently verified task success. An agent can finish without having done the requested work.
- There is no worker-cancel/delete tool. Stop speaking, mute and disconnect do **not** stop workers. Use the normal session UI for worker control.
- Spoken alerts are best effort, not a durable exactly-once inbox. They queue briefly during speech, only while the panel is connected. After reconnecting, ask “what is the status of my workers?”; the ledger retains their results. No hidden/background mobile audio promise.
- Browser/provider tool calls can be mistaken or injected. An optional allowance intentionally delegates ordinary Pi authority; it is not a security sandbox. Prefer individual approvals for sensitive work.
- No automatic reconnect or mutation retry. Inspect the exact session after an uncertain result; a published session may exist even if the plugin did not save its ID before a crash.

## Compatibility

| Component | Development target |
| --- | --- |
| Pi Web | `1.202610.3`; public browser API 4 / server API 3 |
| Pi companion | `@earendil-works/pi-coding-agent@1.2.0` |
| Node | 24+ |
| Audio provider | OpenAI Realtime GA `/v1/realtime/calls` |
| Default audio model | `gpt-realtime-2.1`, from retrieved official examples; account availability unverified |
| Browser | HTTPS or localhost, microphone and WebRTC; modern foreground Chromium/Safari require real-device testing |

This targets `@jmfederico/pi-web`, not other similarly named Pi Web distributions. The sibling Pi Web checkout's v5 APIs are deliberately not assumed. All plugin runtime integration uses public package entrypoints; no session database scans, internal HTTP session routes or provider credential-store scraping.

## Build and activate when safe

```sh
npm ci --ignore-scripts
npm run verify
npm run test:browser  # installed Edge on Windows, otherwise set VOICE_BROWSER_EXECUTABLE
npm pack --ignore-scripts
```

1. Give the **session daemon process** an `OPENAI_API_KEY` with Realtime access and billing. A ChatGPT/Codex subscription login is not assumed to supply Realtime API billing. Do not put a key in the browser, repository, plugin settings or a project prompt.
2. In **Settings → Pi packages** on the intended machine, install the built checkout or tarball. Install it as a Pi package so `dist/companion.js` is discovered; a web-plugin symlink alone is insufficient.
3. Enable `compn3rd.voice` in **Settings → Pi Web plugins**. It is disabled by default. Ensure the companion is enabled/trusted for the worker sessions.
4. **Arrange a manual session-daemon restart from outside the sessions it hosts. This interrupts active sessions and terminals.** No restart is run by this repository's scripts. Browser reload, web/API restart and Pi `/reload` alone cannot activate a new server plugin.
5. Reload the browser, select machine/project/workspace, open/pin **Voice**, and test with a harmless task while parked.

Optional configuration under the normal Pi Web plugin settings (restart required):

```json
{
  "plugins": {
    "compn3rd.voice": {
      "settings": {
        "realtimeModel": "gpt-realtime-2.1",
        "turnDetection": "semantic"
      }
    }
  }
}
```

`turnDetection: "silence"` selects a 1000 ms silence threshold with server VAD; semantic mode uses low eagerness for longer thinking pauses. Output voice is currently `marin`. Change the model to an account-supported **Realtime** model if necessary; GPT-Live and Gemini Live are different protocols and are not interchangeable strings.

## Typical interaction

1. Start voice: “Start a worker to inspect the failing unit test. Do not edit files yet.”
2. Without an allowance, the model proposes exact task text; review its scope/model and choose **Approve exact instruction**. Alternatively, before hands-free use, explicitly allow three instructions for ten minutes.
3. “What are my workers doing?” → metadata only. “Read the result of that worker” → the selected bounded worker text is sent to the audio provider.
4. A worker using `voice_request_input` becomes `needs-input`. “Read its question,” then “Reply to that worker: use the existing implementation.” The follow-up is another approved/allowance-consuming instruction.
5. “Go quiet” mutes microphone transmission and revokes the allowance. Tap Resume when ready. “Stop speaking” is a UI button; ordinary speech can also barge in through provider VAD.

Select a hosted conversation and choose **Load available models**, or enter an exact worker model ID in the text fallback. The voice model must never guess provider IDs. It can use an exact ID you supply; a model-list voice tool is not yet exposed.

## Storage and recovery

The backend stores versioned JSON ledgers in its host-provided `dataDirectory`, partitioned by a SHA-256 of project/workspace IDs. Each includes worker/session IDs, title/model, status, bounded final text/question, timestamps, revisions and request hashes. The original task lives in the ordinary Pi conversation; raw microphone audio is not persisted by this plugin. Provider-side retention is separate.

Admission is persisted before session creation; session identity before kickoff. File content is flushed and atomically renamed. There is no distributed transaction with Pi Web and no power-loss durability certification. Failed writes block further admissions in that backend activation. On restart or lost observation, records become `unknown` (retaining any prior settled text); only an already-hosted companion can reconcile their current state. Open the exact saved conversation in Pi Web if needed, then refresh. No saved conversation is silently resumed by the plugin.

Prototype limits: three active/uncertain workers per workspace, 30 worker records and 1000 admission receipts per workspace, 128 accepted instructions per companion worker. Receipts are not evicted because eviction would permit replay. There is no retention/cleanup UI yet; archive the plugin ledger **only offline after reconciling all work**, and keep session history. A manual archive loses that ledger's deduplication history. Never clear unknown work just to bypass the active-worker cap.

## Development and delivery

`npm run verify` runs strict typechecking, unit/contract fixtures and builds browser/server/companion bundles. `npm run test:browser` uses Playwright Core with an already-installed browser and a wholly intercepted fake host/provider/media fixture; it does not download a browser, access the live daemon or use a microphone/API key. `VOICE_BROWSER_EXECUTABLE` selects another Chromium-based browser.

The package is `private: true`, has no publication/install lifecycle script, and is not published or pushed. `dist/browser` is the only browser-public asset directory. Review the security/device acceptance matrix before relaxing the experimental label.

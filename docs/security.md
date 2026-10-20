# Security, privacy and operating boundary

## Trust model

Pi Web and its plugins run trusted code, with the daemon account's filesystem/process permissions. Use a private network/VPN/SSH tunnel or an authenticated HTTPS reverse proxy; do not expose the Pi Web host directly to the public internet. The package peer inherits host routing and deployment access controls. It **does not add a user-login/CSRF system**, and model-provider OAuth is not browser-user authentication.

The voice plugin does not use private session HTTP routes, provider credential stores or the host's database. One administrative project-registration request was made during development to add the new repository; that operation is not embedded in the plugin runtime.

## Authority

- Voice tools are allowlisted and cannot mint their own allowance, select arbitrary filesystem paths or run a shell directly.
- Without an allowance, task proposals stay in the browser until their exact text is approved.
- A human can explicitly arm one manually approved instruction, or up to three instructions for ten minutes. Tokens are server-generated, workspace-scoped, held in browser memory and never passed as model tool results. Follow-ups spend an instruction too.
- The allowance is **broad delegation within that workspace**, not semantic verification of a spoken command. Another speaker or prompt-injected model might use it. The resulting ordinary Pi agent can edit/run commands according to its normal tools and permissions. Use default individual approvals for sensitive work.
- Allowances live only in backend memory and expire on daemon restart. One current allowance exists per workspace; another tab can replace/revoke it. Mute/disconnect/scope change attempts revocation and clears the local token. Transport loss can prevent remote revocation, so the expiry/count limit remains the backstop.
- Explicit prompts in worker results are data, not authority. Notification generation uses no tools and only status/IDs. Reading full results is opt-in, but instruction-following by the model is not a security boundary. Do not treat prompt wording as a guarantee against injection.

## Data flows

| Data | Destination/storage |
| --- | --- |
| Captured microphone audio while active | OpenAI via browser WebRTC |
| Muted microphone | Track disabled; captured samples are not transmitted, connection may remain alive |
| Audio output | OpenAI → browser speaker |
| Long-lived OpenAI API key | Session-daemon environment → fixed HTTPS OpenAI session endpoint only |
| SDP | Browser ↔ backend ↔ OpenAI; not logged by plugin |
| Task text | Normal Pi worker conversation/provider |
| Worker status/IDs | Browser; minimal spoken alerts via OpenAI while connected |
| Bounded worker text/question | Backend ledger/browser; sent to OpenAI only through requested voice read or an instruction receipt returning that state |
| Thinking/tool payloads | Not exported by companion |
| Raw audio files | Not created by plugin |

Provider retention, region, training and zero-data-retention eligibility are account/endpoint/contract matters. See [OpenAI data controls](https://developers.openai.com/api/docs/guides/your-data). This project makes no universal no-retention/no-training claim. The selected text worker provider has its own policies. Human transcripts are not separately generated for UI/audit; the exact delegated text—not an assumed perfect transcript—is the meaningful approval artifact.

## Failure handling

- No automatic mutation retries or reconnect loops. Same request ID + same payload returns its prior admission; changed payload is rejected.
- Disk errors block further admission. Session and companion persistence are separate, so cross-process exactly-once guarantees are not claimed.
- Ordinary Pi `sendUserMessage` is fire-and-forget. A 15-second watchdog marks unobserved start as unknown without retry. A task can still appear later; inspect before creating replacement work.
- Lost tracking, unrelated prompts, or branch navigation invalidate worker attribution. Follow-ups need both the current ledger revision and exact companion sequence/status.
- Reopening/refreshing reconciles only hosted sessions. It does not silently load arbitrary session files or start saved work.
- Closing voice does not abort work. There is no generic cancel/delete tool in this prototype.
- WebRTC startup times out after 30 seconds; provider SDP setup is bounded to 8 seconds; voice connections end after 25 minutes. The server limits setup attempts to four per minute per plugin activation. These are simple abuse/cost guardrails, not a monetary spending cap or per-user quota.
- Backend-owned dispatch admission and final persistence are drained at disposal. Published sessions belong to the user and are not discarded.

## Before real use

1. Review exact package contents and install only the companion/plugin you trust.
2. Keep secrets out of `.pi-web` project configuration, browser storage, source files, logs and model prompts.
3. Confirm HTTPS, authenticated/private access, origin policy and microphone permission on the actual device.
4. Set provider account usage limits/alerts; connected voice usage and worker usage are separate costs. UI has no reliable token-to-currency accounting yet.
5. Test a harmless task without file edits. Inspect the exact conversation and compare spoken claims with the real result.
6. Test backgrounding, lock, Bluetooth route changes, weak network, competing browser tabs, pending questions and failed provider billing while parked.
7. Do not depend on this for safety-critical interaction or operate its setup/debugging screens while driving.

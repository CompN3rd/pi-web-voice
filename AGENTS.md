# Development guardrails

- Read README.md and docs/design.md before expanding scope. This is an experimental prototype, not a certified driving assistant.
- Use only public Pi Web package entrypoints matching the pinned API4/3 target. Do not copy API5 examples from sibling main or add private session routes/database access.
- Keep native audio transport separate from text worker model selection. No long-lived provider secrets or raw audio persistence in browser code.
- Never auto-retry uncertain session creation or prompt delivery. Preserve durable admission, exact IDs, request hashes, revision/sequence fences and unknown outcomes.
- Microphone off/mute state and explicit instruction permissions are invariants, not cosmetic UI labels. Context changes must discard stale results and revoke old-context allowances.
- Run npm run verify and npm run test:browser (requires an installed Chromium/Edge executable). Tests use fake media/provider/host; do not describe them as live acceptance.
- Do not install, activate, publish, push, or restart a live daemon without explicit authorization. A session-daemon restart interrupts active sessions and terminals.
- Keep package private until separate live-host/provider/device acceptance and owner release approval. Avoid paid provider requests by default; never scan credential files to make tests pass.

# Vision: a local-first vocal orchestration plane for Pi Web

## Guiding star

Bring the fidelity of Claude Voice Mode on web and mobile to vocal interaction with Pi Web. Claude Voice Mode is the experience benchmark: talking with agents should feel natural, fluid and responsive, rather than like operating a dictation form.

Our differentiator is to pursue that experience with **open-source speech models executing on the hardware running the browser**—phone or desktop—not by depending on a paid cloud speech service or moving speech inference to the Pi Web server. This local-speech goal is separate from the models and providers used by coding agents; it does not imply that all agent inference is local.

## Beyond a conversation with one agent

The larger goal is a **vocal orchestration plane across projects and workspace sessions**:

- Delegate work to the appropriate project/workspace session by voice while each worker retains its own context.
- Receive useful progress, results and requests for input back through the voice experience.
- Let workers signal when they need attention, answer in the correct context, and let them continue independently.
- Make managing several concurrent projects easier than repeatedly opening conversations and manually carrying context between them.

These are independently contextualized project/workspace sessions, not necessarily “subsessions” in Pi Web terminology. The experience should make their identity, target and authority clear rather than pretending they share one conversation.

## Longer horizon: federated work

Explore extending this orchestration across machines through Pi Web's first-party multi-machine federation. The ambition is one coherent vocal interaction surface for work distributed across projects, workspaces and machines, with explicit routing and trustworthy feedback. Federation is a direction to investigate, not a claim of current plugin support.

## How this guides development

Natural interaction quality and reliable delegation/feedback are the product goals; the current push-to-talk, reviewed-transcript workflow is a starting point, not the final experience ceiling. Evaluate future interaction designs against both goals while preserving explicit instruction authority, microphone/off guarantees, context isolation and conservative handling of uncertain delivery.

This vision does not itself authorize hands-free dispatch, background recording, cross-project access or a host API migration. New capabilities need deliberate design and validation against the supported public Pi Web APIs. Open-source model/runtime licensing and redistribution obligations still require qualification.

## Vision versus current capability

This is the long-term product direction, not an implementation or acceptance claim. The current prototype is foreground-only, explicitly approved and selected-workspace-scoped; cross-project orchestration, general input-request bridging and federation are not implemented. See [the README](../README.md) for present capabilities and limits, and [the design](design.md) for current architecture and safety contracts.

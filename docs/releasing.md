# CI and future npm publishing

The repository uses the tag-release pattern from the sibling `pi-web-automations` repository, with pinned action revisions, Node 24, least-privilege jobs, a GitHub `npm` environment, and npm trusted publishing (OIDC). No npm token secret is used.

## What runs automatically

- Pushes to `main`, pull requests, or manual CI dispatch: `npm ci --ignore-scripts`, `npm run verify`, locked Playwright Chromium installation, browser tests, and the pinned recognition-runtime browser checks. Speech weights are not downloaded and no paid provider is contacted.
- A `v*` tag push or manual publish dispatch: release checks first, then reusable CI, a verified package build, and publication of the hash-checked tarball via OIDC. Manual dispatch must select a matching tag, not a branch.
- Release checks require a stable `v<package.json version>` tag on `main` history, consistent lockfile identity, the confirmed repository URL, and **explicit `private: false`**. The publication job rechecks the package identity and privacy state from the actual artifact.

**The current prototype cannot publish.** It remains private with unresolved acceptance/licensing gates. Ordinary pushes never publish, and creating a tag does not bypass those gates. `test/release.test.mjs` asserts the current prototype remains blocked.

## Owner setup before the first release

1. Complete isolated Node 24 host, real model/device and licensing/redistribution qualification. Obtain explicit owner release approval. See `validation.md`, `voice-desk-validation.md` and `tts-qualification.md`.
2. Confirm source visibility and redistribution permission. The repository was confirmed PRIVATE during pipeline setup; no visibility change was made. Confirm public source/provenance requirements before using the workflow's public npm/provenance publication mode.
3. Configure the GitHub **npm** environment with the desired required reviewers and release-tag restrictions, subject to the repository's GitHub plan. Do not treat an environment name alone as an approval gate.
4. Configure the npm package's GitHub Actions trusted publisher for owner **CompN3rd**, repository **pi-web-voice**, workflow filename **publish.yml**, environment **npm**. If npm requires package creation/bootstrap before trusted-publisher configuration, perform that as a separately approved release operation. No token fallback is provided.
5. In an approved release-preparation change, set `private` to `false`, add repository URL `git+https://github.com/CompN3rd/pi-web-voice.git`, update package/lock versions together, and replace the prototype-only test assertion with the approved release-state policy. Review all other gates; editing metadata is not acceptance evidence.
6. Merge and verify CI. Push the matching stable version tag from the approved commit on `main` history. The npm environment and trusted publisher must be ready first. Verify the published version, integrity and provenance before announcing a release.

CI installation is ephemeral runner tooling, not installation/activation of the plugin into a Pi Web instance. Publishing does not activate or restart any live daemon. The repository workflow files do not configure npm account trust or GitHub environment protection by themselves.

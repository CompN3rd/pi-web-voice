import { build } from "esbuild";
import { lstat, rm } from "node:fs/promises";
import { copySpeechNotices, packageRoot, sha256, speechManifest } from "./speech-assets.mjs";
import { checkBrowserDirectory } from "./check-package-size.mjs";

process.chdir(packageRoot);
const assets = await speechManifest();
for (const path of ["dist", "dist/browser", "dist/browser/speech"]) {
  try {
    if ((await lstat(path)).isSymbolicLink()) throw new Error(`Refusing generated speech cleanup through symlink: ${path}`);
  } catch (error) { if (error.code !== "ENOENT") throw error; }
}
// Remove only obsolete generated assets owned by this worktree's old build.
// The externally provisioned operator pack is never touched by build.
await rm("dist/browser/speech/models", { recursive: true, force: true });
await rm("dist/browser/speech/ort", { recursive: true, force: true });
await copySpeechNotices("dist/browser/speech");
const cache = `pi-voice-speech-${sha256(JSON.stringify(assets)).slice(0, 24)}`;
const browser = { bundle: true, format: "esm", platform: "browser", target: "es2022" };
await build({ ...browser, entryPoints: ["src/browser/recognition-worker.ts"], outfile: "dist/browser/recognition-worker.js", define: { __SPEECH_ASSETS__: JSON.stringify(assets), __SPEECH_CACHE__: JSON.stringify(cache) } });
await build({ ...browser, entryPoints: ["src/browser/recognition-worklet.ts"], outfile: "dist/browser/recognition-worklet.js" });
if (process.argv.includes("--speech-only")) {
  await build({ ...browser, entryPoints: ["src/browser/audio.ts"], outfile: "dist/browser/local-recognizer.js" });
} else {
  await build({ ...browser, entryPoints: ["src/browser/index.ts"], outfile: "dist/browser/index.js" });
  await build({ entryPoints: ["src/server.ts"], outfile: "dist/server.js", bundle: true, format: "esm", platform: "node", target: "node24" });
  await build({ entryPoints: ["src/companion.ts"], outfile: "dist/companion.js", bundle: true, format: "esm", platform: "node", target: "node24", packages: "external" });
}
await checkBrowserDirectory("dist/browser");

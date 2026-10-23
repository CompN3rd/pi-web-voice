import { build } from "esbuild";
import { lstat, rm, readdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { copySpeechNotices, packageRoot, speechCacheName, speechManifest } from "./speech-assets.mjs";
import { checkBrowserDirectory, checkPackage } from "./check-package-size.mjs";

process.chdir(packageRoot);
const assets = await speechManifest();
const ttsAssets = await speechManifest("tts");
const packInfo = {
  recognition: { kind: "recognition", cacheName: speechCacheName("recognition", assets), assets },
  tts: { kind: "tts", cacheName: speechCacheName("tts", ttsAssets), assets: ttsAssets },
};
for (const path of ["dist", "dist/browser", "dist/browser/speech", "dist/browser/tts"]) {
  try {
    if ((await lstat(path)).isSymbolicLink()) throw new Error(`Refusing generated speech cleanup through symlink: ${path}`);
  } catch (error) { if (error.code !== "ENOENT") throw error; }
}
// Remove only obsolete generated assets owned by this worktree's old build.
// The externally provisioned operator pack is never touched by build.
await rm("dist/browser/speech/models", { recursive: true, force: true });
await rm("dist/browser/speech/ort", { recursive: true, force: true });
await copySpeechNotices("dist/browser/speech");
const cache = speechCacheName("recognition", assets);
await copySpeechNotices("dist/browser/tts", "tts");
// Bind page/worker compatibility to served source and installed dependency pins.
const identity = createHash("sha256");
for (const path of ["package-lock.json", "scripts/build.mjs", ...((await readdir("src/browser")).filter(name => name.endsWith(".ts")).sort().map(name => `src/browser/${name}`))]) {
  identity.update(path).update("\0").update(await readFile(path)).update("\0");
}
identity.update(JSON.stringify(packInfo));
const ttsDefines = { __TTS_ASSETS__: JSON.stringify(ttsAssets), __TTS_CACHE__: JSON.stringify(packInfo.tts.cacheName), __TTS_BUILD__: JSON.stringify(identity.digest("hex")) };
const browser = { bundle: true, format: "esm", platform: "browser", target: "es2022", define: { __VOICE_PACKS__: JSON.stringify(packInfo), ...ttsDefines } };
await build({ ...browser, entryPoints: ["src/browser/tts-bootstrap.ts"], outfile: "dist/browser/tts-bootstrap.js" });
await build({ ...browser, entryPoints: ["src/browser/tts-worker.ts"], outfile: "dist/browser/tts-worker.js" });
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
if (!process.argv.includes("--speech-only")) checkPackage();

import { build } from "esbuild";
await build({ entryPoints: ["src/browser/index.ts"], outfile: "dist/browser/index.js", bundle: true, format: "esm", platform: "browser", target: "es2022" });
await build({ entryPoints: ["src/server.ts"], outfile: "dist/server.js", bundle: true, format: "esm", platform: "node", target: "node24" });
await build({ entryPoints: ["src/companion.ts"], outfile: "dist/companion.js", bundle: true, format: "esm", platform: "node", target: "node24", packages: "external" });

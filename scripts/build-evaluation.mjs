import { mkdirSync } from "node:fs";
import { build } from "esbuild";
mkdirSync(".artifacts/intake-evaluation", { recursive: true });
await build({ entryPoints: ["server/evaluation-lambda.ts"], outfile: ".artifacts/intake-evaluation/index.js", bundle: true, platform: "node", format: "cjs", target: "node22", minify: false });

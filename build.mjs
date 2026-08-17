import * as esbuild from "esbuild";
import { copyFile, mkdir } from "node:fs/promises";

const watch = process.argv.includes("--watch");

const common = {
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  sourcemap: true,
  external: ["electron", "@huggingface/transformers", "onnxruntime-node", "ffmpeg-static"],
  logLevel: "info",
};

const builds = [
  { entryPoints: ["src/main/index.ts"], outfile: "dist/main.js", ...common },
  { entryPoints: ["src/preload/index.ts"], outfile: "dist/preload.js", ...common },
  {
    entryPoints: ["src/renderer/app.ts"],
    outfile: "dist/renderer.js",
    bundle: true,
    platform: "browser",
    target: "es2022",
    format: "iife",
    sourcemap: true,
    logLevel: "info",
  },
];

await mkdir("dist", { recursive: true });
await copyFile("src/renderer/index.html", "dist/index.html");
await copyFile("src/renderer/styles.css", "dist/styles.css");

if (watch) {
  const ctxs = await Promise.all(builds.map((b) => esbuild.context(b)));
  await Promise.all(ctxs.map((c) => c.watch()));
  console.log("watching…");
} else {
  await Promise.all(builds.map((b) => esbuild.build(b)));
}

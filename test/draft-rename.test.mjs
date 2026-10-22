import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const require = createRequire(import.meta.url);

test("playlist and track renaming in Electron", { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "yoto-draft-rename-"));
  try {
    const html = await readFile(new URL("../src/renderer/index.html", import.meta.url), "utf8");
    await writeFile(join(directory, "index.html"), html.replace('<script src="renderer.js"></script>', ""));
    await writeFile(join(directory, "styles.css"), await readFile(new URL("../src/renderer/styles.css", import.meta.url)));
    await build({
      entryPoints: [fileURLToPath(new URL("../src/renderer/app.ts", import.meta.url))],
      outfile: join(directory, "renderer.js"),
      bundle: true,
      platform: "browser",
      target: "es2022",
      format: "iife",
      logLevel: "silent",
    });
    await build({
      entryPoints: [fileURLToPath(new URL("../src/main/api.ts", import.meta.url))],
      outfile: join(directory, "main-api.cjs"),
      bundle: true,
      platform: "node",
      format: "cjs",
      external: ["electron", "@huggingface/transformers", "onnxruntime-node", "ffmpeg-static"],
      logLevel: "silent",
      plugins: [{
        name: "mock-auth",
        setup(builder) {
          builder.onResolve({ filter: /^\.\/auth\.js$/ }, () => ({ path: "auth", namespace: "test" }));
          builder.onLoad({ filter: /.*/, namespace: "test" }, () => ({ contents: 'export async function getValidAccessToken() { return "mock-token"; }' }));
        },
      }],
    });
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const { stdout } = await promisify(execFile)(require("electron"), [
      fileURLToPath(new URL("fixtures/draft-rename.cjs", import.meta.url)), directory,
    ], { env, timeout: 25_000 });
    assert.match(stdout, /Draft rename regression checks passed/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

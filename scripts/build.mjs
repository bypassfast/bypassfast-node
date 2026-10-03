// Builds dist/esm (ES modules) and dist/cjs (CommonJS), each with its own
// type declarations, using only the TypeScript compiler.
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");

rmSync(join(root, "dist"), { recursive: true, force: true });

for (const [project, type] of [
  ["tsconfig.esm.json", "module"],
  ["tsconfig.cjs.json", "commonjs"],
]) {
  const result = spawnSync(process.execPath, [tsc, "-p", join(root, project)], { stdio: "inherit" });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
  const outDir = join(root, "dist", type === "module" ? "esm" : "cjs");
  mkdirSync(outDir, { recursive: true });
  // Marks the format of every .js file below, independent of the root package.
  writeFileSync(join(outDir, "package.json"), JSON.stringify({ type }) + "\n");
}

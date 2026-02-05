import { execSync, execFileSync } from "node:child_process";
import { mkdir, rm, cp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { build } from "esbuild";

const root = process.cwd();
const target = process.argv.find((arg) => arg.startsWith("--target="))?.split("=")[1] ?? "macos-x64";

const outDir = path.join(root, "dist");
const webDist = path.join(root, "apps", "web", "dist");
const serverDist = path.join(root, "apps", "server", "dist");
const serverPublic = path.join(serverDist, "public");
const publicForPkg = path.join(outDir, "public");
const pkgCache = path.join(outDir, ".pkg-cache");
const bundledServer = path.join(outDir, "server.cjs");
const bundledServerRel = path.relative(root, bundledServer);
const publicAssetsRel = path.relative(root, publicForPkg) + "/**/*";
const outputName = `smartech-integrator-${target.replace(/[^a-z0-9-]/gi, "")}`;

async function patchPkgFetchProgress() {
  const logPath = path.join(root, "node_modules", "pkg-fetch", "lib-es5", "log.js");
  try {
    const content = await readFile(logPath, "utf8");
    if (content.includes("this.disableProgress();") || !content.includes("assert_1.default")) {
      return;
    }
    const patched = content.replace(
      "(0, assert_1.default)(!this.bar);",
      "if (this.bar) { this.disableProgress(); }\n        (0, assert_1.default)(!this.bar);"
    );
    await writeFile(logPath, patched);
    console.log("Patched pkg-fetch progress guard.");
  } catch (error) {
    console.warn("Warning: could not patch pkg-fetch progress guard:", error?.message ?? error);
  }
}

execSync("npm --workspace apps/web run build", { stdio: "inherit" });
execSync("npm --workspace apps/server run build", { stdio: "inherit" });

await rm(serverPublic, { recursive: true, force: true });
await mkdir(serverPublic, { recursive: true });
await cp(webDist, serverPublic, { recursive: true });

await mkdir(outDir, { recursive: true });
await rm(publicForPkg, { recursive: true, force: true });
await mkdir(publicForPkg, { recursive: true });
await cp(webDist, publicForPkg, { recursive: true });
await mkdir(pkgCache, { recursive: true });

await build({
  entryPoints: [path.join(serverDist, "index.js")],
  bundle: true,
  platform: "node",
  target: "node18",
  format: "cjs",
  outfile: bundledServer
});

await patchPkgFetchProgress();

execFileSync(
  "npx",
  [
    "pkg",
    bundledServerRel,
    "--targets",
    `node18-${target}`,
    "--output",
    path.join(outDir, outputName),
    "--assets",
    publicAssetsRel
  ],
  { stdio: "inherit", cwd: root, env: { ...process.env, PKG_CACHE_PATH: pkgCache } }
);

console.log(`\nExecutable created: ${path.join(outDir, outputName)}\n`);

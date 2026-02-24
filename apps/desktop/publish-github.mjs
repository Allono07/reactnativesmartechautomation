import { spawnSync } from "node:child_process";

const repoSlug = process.env.GITHUB_REPOSITORY || "";
const [slugOwner, slugRepo] = repoSlug.includes("/") ? repoSlug.split("/", 2) : ["", ""];
const owner = process.env.SMARTECH_GH_OWNER || slugOwner;
const repo = process.env.SMARTECH_GH_REPO || slugRepo;
const publishArgIndex = process.argv.findIndex((arg) => arg === "--publish");
const publishMode = process.argv.includes("--publish=always")
  ? "always"
  : publishArgIndex >= 0 && process.argv[publishArgIndex + 1] === "always"
    ? "always"
    : "never";

if (!owner || !repo) {
  console.error("Missing GitHub release config.");
  console.error("Set SMARTECH_GH_OWNER and SMARTECH_GH_REPO (or GITHUB_REPOSITORY), then rerun.");
  process.exit(1);
}

const args = [
  "electron-builder",
  "--mac",
  "--arm64",
  "--publish",
  publishMode,
  "-c.publish.provider=github",
  `-c.publish.owner=${owner}`,
  `-c.publish.repo=${repo}`
];

const result = spawnSync("npx", args, { stdio: "inherit" });
process.exit(result.status ?? 1);

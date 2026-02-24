import { spawn } from "node:child_process";

const DEV_URL = process.env.ELECTRON_RENDERER_URL || "http://localhost:5173";
const WAIT_TIMEOUT_MS = 120_000;
const WAIT_INTERVAL_MS = 500;

async function waitForUrl(url) {
  const start = Date.now();
  while (Date.now() - start < WAIT_TIMEOUT_MS) {
    try {
      const response = await fetch(url, { method: "GET" });
      if (response.ok || response.status >= 300) {
        return;
      }
    } catch {
      // wait and retry
    }
    await new Promise((resolve) => setTimeout(resolve, WAIT_INTERVAL_MS));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function run() {
  await waitForUrl(DEV_URL);
  const electronBinary = process.platform === "win32" ? "electron.cmd" : "electron";
  const child = spawn(electronBinary, ["."], {
    stdio: "inherit",
    env: { ...process.env, ELECTRON_RENDERER_URL: DEV_URL }
  });
  child.on("exit", (code) => {
    process.exit(code ?? 0);
  });
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

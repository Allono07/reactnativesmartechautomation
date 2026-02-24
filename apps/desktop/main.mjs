import { app, BrowserWindow, dialog, ipcMain } from "electron";
import path from "node:path";
import { promises as fs, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { applyChanges, planIntegration } from "@smartech/engine";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function detectParts(appPlatform, parts) {
  if (appPlatform === "flutter") {
    return [
      "base",
      ...(parts.includes("push") ? ["push"] : []),
      ...(parts.includes("px") ? ["px"] : [])
    ];
  }
  if (appPlatform === "android-native") {
    return ["base", ...(parts.includes("push") ? ["push"] : []), ...(parts.includes("px") ? ["px"] : [])];
  }
  return ["base", ...parts.filter((part) => part !== "base")];
}

async function detectFlutterProject(rootPath) {
  try {
    const pubspecPath = path.join(rootPath, "pubspec.yaml");
    const contents = await fs.readFile(pubspecPath, "utf-8");
    return /(^|\n)flutter:\s*$/m.test(contents);
  } catch {
    return false;
  }
}

async function normalizeOptions(options) {
  const normalized = { ...options };
  if (!normalized.appPlatform) {
    normalized.appPlatform = (await detectFlutterProject(normalized.rootPath)) ? "flutter" : "react-native";
  }
  normalized.parts = detectParts(normalized.appPlatform, normalized.parts ?? ["base"]);
  return normalized;
}

function resolveWebEntry() {
  const candidates = [
    path.join(__dirname, "..", "web", "dist", "index.html"),
    path.join(process.cwd(), "apps", "web", "dist", "index.html")
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl) {
    win.loadURL(devUrl);
    return win;
  }

  const webEntry = resolveWebEntry();
  if (webEntry) {
    win.loadFile(webEntry);
    return win;
  }

  win.loadURL("data:text/plain,Web build not found. Run npm --workspace apps/web run build");

  return win;
}

async function setupAutoUpdates(win) {
  if (!app.isPackaged) return;

  let autoUpdater;
  try {
    ({ autoUpdater } = await import("electron-updater"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[auto-update] electron-updater not available: ${message}`);
    return;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("error", (error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[auto-update] ${message}`);
  });

  autoUpdater.on("update-downloaded", async () => {
    const result = await dialog.showMessageBox(win, {
      type: "info",
      buttons: ["Restart Now", "Later"],
      defaultId: 0,
      cancelId: 1,
      title: "Update Ready",
      message: "A new version has been downloaded.",
      detail: "Restart now to apply the update."
    });
    if (result.response === 0) {
      autoUpdater.quitAndInstall();
    }
  });

  const checkForUpdates = async () => {
    try {
      await autoUpdater.checkForUpdatesAndNotify();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[auto-update] check failed: ${message}`);
    }
  };

  setTimeout(() => {
    void checkForUpdates();
  }, 2000);

  setInterval(() => {
    void checkForUpdates();
  }, 6 * 60 * 60 * 1000);
}

ipcMain.handle("smartech:select-project-dir", async () => {
  const result = await dialog.showOpenDialog({
    title: "Select Project Directory",
    properties: ["openDirectory"]
  });
  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }
  return result.filePaths[0];
});

ipcMain.handle("smartech:plan-integration", async (_event, options) => {
  const normalized = await normalizeOptions(options);
  return planIntegration(normalized);
});

ipcMain.handle("smartech:apply-integration", async (_event, payload) => {
  const selectedIds = Array.isArray(payload?.selectedChangeIds) ? payload.selectedChangeIds : null;
  const options = payload?.options ? await normalizeOptions(payload.options) : null;
  const changes = Array.isArray(payload?.changes) ? payload.changes : [];

  const results = await applyChanges(changes, false);
  let remaining = [];
  let retryResults = [];
  let remainingChanges = [];

  if (options?.rootPath && options?.parts?.length) {
    const maxAttempts = 2;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const verifyPlan = await planIntegration(options);
      const filtered = selectedIds
        ? verifyPlan.changes.filter((change) => selectedIds.includes(change.id))
        : verifyPlan.changes;
      remaining = filtered.map((change) => change.id);
      if (filtered.length === 0) break;
      const attemptResults = await applyChanges(filtered, false);
      retryResults = retryResults.concat(attemptResults);
    }

    const finalPlan = await planIntegration(options);
    const finalFiltered = selectedIds
      ? finalPlan.changes.filter((change) => selectedIds.includes(change.id))
      : finalPlan.changes;
    remaining = finalFiltered.map((change) => change.id);
    remainingChanges = finalFiltered.map((change) => ({
      id: change.id,
      title: change.title,
      summary: change.summary,
      filePath: change.filePath,
      manualSnippet: change.manualSnippet,
      module: change.module
    }));
  }

  return { results, retryResults, remaining, remainingChanges };
});

app.whenReady().then(() => {
  const win = createWindow();
  void setupAutoUpdates(win);
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

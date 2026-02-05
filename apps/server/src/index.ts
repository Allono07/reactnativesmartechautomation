import express from "express";
import cors from "cors";
import path from "node:path";
import { promises as fs } from "node:fs";
import { planIntegration, applyChanges } from "@smartech/engine";
import type { IntegrationOptions } from "@smartech/shared";

const app = express();
const port = 8787;

app.use(cors());
app.use(express.json({ limit: "1mb" }));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

async function detectFlutterProject(rootPath: string): Promise<boolean> {
  try {
    const pubspecPath = path.join(rootPath, "pubspec.yaml");
    const contents = await fs.readFile(pubspecPath, "utf-8");
    return /(^|\n)flutter:\s*$/m.test(contents);
  } catch {
    return false;
  }
}

app.post("/api/plan", async (req, res) => {
  try {
    const options = req.body as IntegrationOptions;

    if (!options?.rootPath) {
      return res.status(400).json({ error: "rootPath is required" });
    }

    if (!options?.parts?.length || !options.parts.includes("base")) {
      return res.status(400).json({ error: "parts must include base" });
    }

    if (!options.appPlatform) {
      options.appPlatform = (await detectFlutterProject(options.rootPath)) ? "flutter" : "react-native";
    }

    if (options.appPlatform === "flutter") {
      options.parts = [
        "base",
        ...(options.parts.includes("push") ? ["push"] : []),
        ...(options.parts.includes("px") ? ["px"] : [])
      ];
    }

    if (!options.inputs?.smartechAppId) {
      return res.status(400).json({ error: "smartechAppId is required" });
    }

    if (!options.inputs?.deeplinkScheme) {
      return res.status(400).json({ error: "deeplinkScheme is required" });
    }

    if (options.appPlatform === "flutter") {
      if (!options.inputs?.flutterBaseSdkVersion) {
        return res.status(400).json({ error: "flutterBaseSdkVersion is required for Flutter" });
      }
      if (!options.inputs?.baseSdkVersion) {
        return res.status(400).json({ error: "baseSdkVersion is required for Flutter" });
      }
      if (options.parts.includes("push")) {
        if (!options.inputs?.flutterPushSdkVersion) {
          return res.status(400).json({ error: "flutterPushSdkVersion is required for Flutter Push" });
        }
        if (!options.inputs?.pushSdkVersion) {
          return res.status(400).json({ error: "pushSdkVersion is required for Flutter Push" });
        }
        if (!options.inputs?.mainDartPath) {
          return res.status(400).json({ error: "mainDartPath is required for Flutter Push" });
        }
      }
      if (options.parts.includes("px")) {
        if (!options.inputs?.flutterPxSdkVersion) {
          return res.status(400).json({ error: "flutterPxSdkVersion is required for Flutter PX" });
        }
        if (!options.inputs?.pxSdkVersion) {
          return res.status(400).json({ error: "pxSdkVersion is required for Flutter PX" });
        }
        if (!options.inputs?.hanselAppId) {
          return res.status(400).json({ error: "hanselAppId is required for Flutter PX" });
        }
        if (!options.inputs?.hanselAppKey) {
          return res.status(400).json({ error: "hanselAppKey is required for Flutter PX" });
        }
        if (!options.inputs?.pxScheme) {
          return res.status(400).json({ error: "pxScheme is required for Flutter PX" });
        }
        if (!options.inputs?.mainDartPath) {
          return res.status(400).json({ error: "mainDartPath is required for Flutter PX" });
        }
      }
    }

    if (options.parts.includes("px")) {
      if (!options.inputs?.hanselAppId) {
        return res.status(400).json({ error: "hanselAppId is required for PX" });
      }
      if (!options.inputs?.hanselAppKey) {
        return res.status(400).json({ error: "hanselAppKey is required for PX" });
      }
      if (!options.inputs?.pxScheme) {
        return res.status(400).json({ error: "pxScheme is required for PX" });
      }
    }

    const pxInputPresent =
      Boolean(options.inputs?.hanselAppId) ||
      Boolean(options.inputs?.hanselAppKey) ||
      Boolean(options.inputs?.pxScheme);

    if (pxInputPresent && !options.parts.includes("px") && options.appPlatform !== "flutter") {
      options.parts = [...options.parts, "px"];
    }

    const plan = await planIntegration(options);
    res.json(plan);
  } catch (error) {
    res.status(500).json({ error: "Failed to generate plan" });
  }
});

app.post("/api/apply", async (req, res) => {
  try {
    const changes = req.body?.changes;
    const selectedIds = Array.isArray(req.body?.selectedChangeIds)
      ? (req.body.selectedChangeIds as string[])
      : null;
    const options = req.body?.options as IntegrationOptions | undefined;

    if (!Array.isArray(changes)) {
      return res.status(400).json({ error: "changes array is required" });
    }

    const results = await applyChanges(changes, false);
    let remaining: string[] = [];
    let retryResults: typeof results = [];

    if (options?.rootPath && options?.parts?.length) {
      if (!options.appPlatform) {
        options.appPlatform = (await detectFlutterProject(options.rootPath)) ? "flutter" : "react-native";
      }
      if (options.appPlatform === "flutter") {
        options.parts = [
          "base",
          ...(options.parts.includes("push") ? ["push"] : []),
          ...(options.parts.includes("px") ? ["px"] : [])
        ];
      }

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
    }

    res.json({ results, retryResults, remaining });
  } catch (error) {
    res.status(500).json({ error: "Failed to apply changes" });
  }
});

app.listen(port, () => {
  console.log(`Smartech server running on http://localhost:${port}`);
});

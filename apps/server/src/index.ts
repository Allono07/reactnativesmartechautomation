import express from "express";
import cors from "cors";
import { planIntegration, applyChanges } from "@smartech/engine";
import type { IntegrationOptions } from "@smartech/shared";

const app = express();
const port = 8787;

app.use(cors());
app.use(express.json({ limit: "1mb" }));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/api/plan", async (req, res) => {
  try {
    const options = req.body as IntegrationOptions;

    if (!options?.rootPath) {
      return res.status(400).json({ error: "rootPath is required" });
    }

    if (!options?.parts?.length || !options.parts.includes("base")) {
      return res.status(400).json({ error: "parts must include base" });
    }

    if (!options.inputs?.smartechAppId) {
      return res.status(400).json({ error: "smartechAppId is required" });
    }

    if (!options.inputs?.deeplinkScheme) {
      return res.status(400).json({ error: "deeplinkScheme is required" });
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

    if (pxInputPresent && !options.parts.includes("px")) {
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
      const verifyPlan = await planIntegration(options);
      const filtered = selectedIds
        ? verifyPlan.changes.filter((change) => selectedIds.includes(change.id))
        : verifyPlan.changes;
      remaining = filtered.map((change) => change.id);

      if (filtered.length > 0) {
        retryResults = await applyChanges(filtered, false);
        const verifyPlan2 = await planIntegration(options);
        const filtered2 = selectedIds
          ? verifyPlan2.changes.filter((change) => selectedIds.includes(change.id))
          : verifyPlan2.changes;
        remaining = filtered2.map((change) => change.id);
      }
    }

    res.json({ results, retryResults, remaining });
  } catch (error) {
    res.status(500).json({ error: "Failed to apply changes" });
  }
});

app.listen(port, () => {
  console.log(`Smartech server running on http://localhost:${port}`);
});

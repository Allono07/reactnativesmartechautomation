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

    const plan = await planIntegration(options);
    res.json(plan);
  } catch (error) {
    res.status(500).json({ error: "Failed to generate plan" });
  }
});

app.post("/api/apply", async (req, res) => {
  try {
    const changes = req.body?.changes;

    if (!Array.isArray(changes)) {
      return res.status(400).json({ error: "changes array is required" });
    }

    const results = await applyChanges(changes, false);
    res.json({ results });
  } catch (error) {
    res.status(500).json({ error: "Failed to apply changes" });
  }
});

app.listen(port, () => {
  console.log(`Smartech server running on http://localhost:${port}`);
});

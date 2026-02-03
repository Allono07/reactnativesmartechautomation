import React, { useMemo, useState } from "react";
import { IntegrationPlan, IntegrationPart } from "@smartech/shared";

const PARTS: { id: IntegrationPart; label: string; description: string }[] = [
  {
    id: "base",
    label: "Base SDK Integration",
    description: "Required core setup for Smartech SDK."
  },
  {
    id: "push",
    label: "Push Integration",
    description: "Optional push enablement, if the client needs it."
  },
  {
    id: "px",
    label: "PX Integration",
    description: "Optional PX module enablement, if needed by the client."
  }
];

const initialParts: IntegrationPart[] = ["base"];

export default function App() {
  const [rootPath, setRootPath] = useState<string>("");
  const [smartechAppId, setSmartechAppId] = useState<string>("");
  const [deeplinkScheme, setDeeplinkScheme] = useState<string>("");
  const [baseSdkVersion, setBaseSdkVersion] = useState<string>("3.7.6");
  const [parts, setParts] = useState<IntegrationPart[]>(initialParts);
  const [plan, setPlan] = useState<IntegrationPlan | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [applyResult, setApplyResult] = useState<string | null>(null);

  const canRun =
    rootPath.trim().length > 0 && smartechAppId.trim().length > 0 && deeplinkScheme.trim().length > 0;

  const summary = useMemo(() => {
    if (!plan) return null;

    return {
      platforms: plan.scan.platforms.join(", ") || "None detected",
      notes: plan.scan.notes,
      changeCount: plan.changes.length
    };
  }, [plan]);

  const togglePart = (part: IntegrationPart) => {
    if (part === "base") {
      return;
    }

    setParts((prev) =>
      prev.includes(part) ? prev.filter((item) => item !== part) : [...prev, part]
    );
  };

  const generatePlan = async () => {
    if (!rootPath) return;

    setLoading(true);
    setError(null);

    try {
      const response = await fetch("http://localhost:8787/api/plan", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          rootPath,
          parts: ["base", ...parts.filter((part) => part !== "base")],
          inputs: {
            smartechAppId,
            deeplinkScheme,
            baseSdkVersion
          }
        })
      });

      if (!response.ok) {
        throw new Error("Failed to generate plan.");
      }

      const nextPlan = (await response.json()) as IntegrationPlan;
      setPlan(nextPlan);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to generate plan.");
    } finally {
      setLoading(false);
    }
  };

  const applyChanges = async () => {
    if (!plan) return;

    setLoading(true);
    setError(null);
    setApplyResult(null);

    try {
      const response = await fetch("http://localhost:8787/api/apply", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ changes: plan.changes })
      });

      if (!response.ok) {
        throw new Error("Failed to apply changes.");
      }

      const payload = (await response.json()) as {
        results: { changeId: string; applied: boolean; message: string }[];
      };
      const summaryText = payload.results
        .map((result) => `${result.changeId}: ${result.applied ? "applied" : "skipped"} (${result.message})`)
        .join("\n");
      setApplyResult(summaryText);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to apply changes.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="app">
      <header className="hero">
        <div>
          <p className="eyebrow">Smartech SDK Integrator</p>
          <h1>Automate React Native SDK setup with confidence.</h1>
          <p className="subtitle">
            Point the tool at a client project, choose modules, and generate a precise integration
            plan with safe edits and previews.
          </p>
        </div>
        <div className="hero-card">
          <div className="field">
            <span className="label">Project Path</span>
            <input
              className="path-input"
              placeholder="/path/to/react-native-project"
              value={rootPath}
              onChange={(event) => setRootPath(event.target.value)}
            />
          </div>
          <div className="field">
            <span className="label">Smartech App ID</span>
            <input
              className="path-input"
              placeholder="YOUR_SMARTECH_APP_ID_HERE"
              value={smartechAppId}
              onChange={(event) => setSmartechAppId(event.target.value)}
            />
          </div>
          <div className="field">
            <span className="label">Deeplink Scheme</span>
            <input
              className="path-input"
              placeholder="your-custom-scheme"
              value={deeplinkScheme}
              onChange={(event) => setDeeplinkScheme(event.target.value)}
            />
          </div>
          <div className="field">
            <span className="label">Base SDK Version</span>
            <input
              className="path-input"
              placeholder="3.7.6"
              value={baseSdkVersion}
              onChange={(event) => setBaseSdkVersion(event.target.value)}
            />
          </div>
          <div className="field">
            <span className="label">Modules</span>
            <div className="module-grid">
              {PARTS.map((part) => (
                <button
                  key={part.id}
                  onClick={() => togglePart(part.id)}
                  className={parts.includes(part.id) ? "module active" : "module"}
                  aria-pressed={parts.includes(part.id)}
                  disabled={part.id === "base"}
                >
                  <div className="module-title">{part.label}</div>
                  <div className="module-desc">{part.description}</div>
                  {part.id === "base" ? <div className="module-lock">Required</div> : null}
                </button>
              ))}
            </div>
          </div>
          <button className="primary" onClick={generatePlan} disabled={!canRun || loading}>
            {loading ? "Scanning..." : "Generate Integration Plan"}
          </button>
          {error ? <div className="error">{error}</div> : null}
        </div>
      </header>

      <main className="content">
        {!plan ? (
          <section className="empty">
            <h2>No plan generated yet.</h2>
            <p>Enter a React Native project path to get started.</p>
          </section>
        ) : (
          <section className="plan">
            <div className="plan-header">
              <div>
                <h2>Integration Plan</h2>
                <p>Review the findings before applying changes.</p>
              </div>
              <div className="metrics">
                <div>
                  <span className="metric-label">Platforms</span>
                  <span className="metric-value">{summary?.platforms}</span>
                </div>
                <div>
                  <span className="metric-label">Planned Changes</span>
                  <span className="metric-value">{summary?.changeCount}</span>
                </div>
              </div>
            </div>

            <div className="panel scan-notes">
              <h3>Scan Notes</h3>
              {summary?.notes.length ? (
                <ul className="notes">
                  {summary.notes.map((note) => (
                    <li key={note}>{note}</li>
                  ))}
                </ul>
              ) : (
                <p className="muted">No issues detected during scan.</p>
              )}
            </div>

            <div className="panel changes-panel">
              <h3>Proposed Changes</h3>
              {plan.changes.length === 0 ? (
                <p className="muted">No changes proposed yet.</p>
              ) : (
                <div className="changes">
                  {plan.changes.map((change) => (
                    <div key={change.id} className="change">
                      <div className="change-title">{change.title}</div>
                      <div className="change-path">{change.filePath}</div>
                      <div className="change-summary">{change.summary}</div>
                      <div className="change-meta">
                        <span>{change.kind.toUpperCase()}</span>
                        <span>Confidence {Math.round(change.confidence * 100)}%</span>
                      </div>
                      {change.patch ? (
                        <pre className="diff">
                          {change.patch.split("\n").map((line, index) => {
                            const trimmed = line.trim();
                            const className =
                              trimmed.startsWith("+")
                                ? "line add"
                                : trimmed.startsWith("-")
                                  ? "line remove"
                                  : trimmed.startsWith("@@") || trimmed.startsWith("---") || trimmed.startsWith("+++")
                                    ? "line meta"
                                    : "line";
                            return (
                              <span key={`${change.id}-line-${index}`} className={className}>
                                {line}
                              </span>
                            );
                          })}
                        </pre>
                      ) : (
                        <p className="muted">No diff available.</p>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="actions">
              <button className="primary" onClick={applyChanges} disabled={loading}>
                {loading ? "Applying..." : "Apply Changes"}
              </button>
              {applyResult ? <pre className="apply-result">{applyResult}</pre> : null}
            </div>
          </section>
        )}
      </main>
    </div>
  );
}

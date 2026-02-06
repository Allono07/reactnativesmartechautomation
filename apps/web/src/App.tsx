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
  const [appPlatform, setAppPlatform] = useState<"react-native" | "flutter">("react-native");
  const [smartechAppId, setSmartechAppId] = useState<string>("");
  const [deeplinkScheme, setDeeplinkScheme] = useState<string>("");
  const [baseSdkVersion, setBaseSdkVersion] = useState<string>("3.7.6");
  const [flutterBaseSdkVersion, setFlutterBaseSdkVersion] = useState<string>("^3.5.0");
  const [flutterPushSdkVersion, setFlutterPushSdkVersion] = useState<string>("^3.5.0");
  const [flutterPxSdkVersion, setFlutterPxSdkVersion] = useState<string>("^1.1.0");
  const [pushSdkVersion, setPushSdkVersion] = useState<string>("3.5.13");
  const [rnPushVersion, setRnPushVersion] = useState<string>("^3.7.2");
  const [firebaseVersion, setFirebaseVersion] = useState<string>("^18.6.0");
  const [autoAskPermission, setAutoAskPermission] = useState(true);
  const [autoFetchLocation, setAutoFetchLocation] = useState(true);
  const [pxSdkVersion, setPxSdkVersion] = useState<string>("10.2.12");
  const [rnPxVersion, setRnPxVersion] = useState<string>("^3.7.0");
  const [hanselAppId, setHanselAppId] = useState<string>("");
  const [hanselAppKey, setHanselAppKey] = useState<string>("");
  const [pxScheme, setPxScheme] = useState<string>("");
  const [mainDartPath, setMainDartPath] = useState<string>("lib/main.dart");
  const [parts, setParts] = useState<IntegrationPart[]>(initialParts);
  const [plan, setPlan] = useState<IntegrationPlan | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [applyResult, setApplyResult] = useState<string | null>(null);
  const [selectedChanges, setSelectedChanges] = useState<Record<string, boolean>>({});
  const [summary, setSummary] = useState<{
    appliedCount: number;
    byModule: Record<string, number>;
  } | null>(null);
  const [showPostApplyNote, setShowPostApplyNote] = useState(false);
  const [verificationMessage, setVerificationMessage] = useState<string | null>(null);
  const [manualSteps, setManualSteps] = useState<
    {
      id: string;
      title: string;
      summary: string;
      filePath: string;
      manualSnippet?: string;
      module?: string;
    }[]
  >([]);

  const canRun =
    rootPath.trim().length > 0 && smartechAppId.trim().length > 0 && deeplinkScheme.trim().length > 0;

  const scanSummary = useMemo(() => {
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
    setApplyResult(null);
    setVerificationMessage(null);
    setManualSteps([]);
    setSummary(null);
    setShowPostApplyNote(false);

    try {
      const activeParts =
        appPlatform === "flutter"
          ? ([
              "base",
              ...(parts.includes("push") ? ["push"] : []),
              ...(parts.includes("px") ? ["px"] : [])
            ] as IntegrationPart[])
          : ["base", ...parts.filter((part) => part !== "base")];
      const inputs: Record<string, any> = {
        smartechAppId,
        deeplinkScheme,
        baseSdkVersion,
        flutterBaseSdkVersion,
        flutterPushSdkVersion,
        flutterPxSdkVersion,
        mainDartPath,
        pushSdkVersion,
        rnPushVersion,
        firebaseVersion,
        autoAskNotificationPermission: autoAskPermission,
        autoFetchLocation
      };

      if (parts.includes("px")) {
        inputs.pxSdkVersion = pxSdkVersion;
        inputs.rnPxVersion = rnPxVersion;
        inputs.hanselAppId = hanselAppId;
        inputs.hanselAppKey = hanselAppKey;
        inputs.pxScheme = pxScheme;
      }

      const response = await fetch("http://localhost:8787/api/plan", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          rootPath,
          parts: activeParts,
          appPlatform,
          inputs
        })
      });

      if (!response.ok) {
        throw new Error("Failed to generate plan.");
      }

      const nextPlan = (await response.json()) as IntegrationPlan;
      setPlan(nextPlan);
      const initialSelection: Record<string, boolean> = {};
      nextPlan.changes.forEach((change) => {
        initialSelection[change.id] = true;
      });
      setSelectedChanges(initialSelection);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to generate plan.");
    } finally {
      setLoading(false);
    }
  };

  const applyChanges = async () => {
    if (!plan) return;

    const selectedList = plan.changes.filter((change) => selectedChanges[change.id]);
    if (selectedList.length === 0) {
      setError("Select at least one change to apply.");
      return;
    }

    setLoading(true);
    setError(null);
    setApplyResult(null);
    setManualSteps([]);

    try {
      const activeParts =
        appPlatform === "flutter"
          ? ([
              "base",
              ...(parts.includes("push") ? ["push"] : []),
              ...(parts.includes("px") ? ["px"] : [])
            ] as IntegrationPart[])
          : ["base", ...parts.filter((part) => part !== "base")];
      const response = await fetch("http://localhost:8787/api/apply", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          changes: selectedList,
          selectedChangeIds: selectedList.map((change) => change.id),
          options: {
            rootPath,
            parts: activeParts,
            appPlatform,
            inputs: {
              smartechAppId,
              deeplinkScheme,
              baseSdkVersion,
              flutterBaseSdkVersion,
              flutterPushSdkVersion,
              flutterPxSdkVersion,
              mainDartPath,
              pushSdkVersion,
              rnPushVersion,
              firebaseVersion,
              autoAskNotificationPermission: autoAskPermission,
              autoFetchLocation,
              ...(parts.includes("px")
                ? {
                    pxSdkVersion,
                    rnPxVersion,
                    hanselAppId,
                    hanselAppKey,
                    pxScheme
                  }
                : {})
            }
          }
        })
      });

      if (!response.ok) {
        throw new Error("Failed to apply changes.");
      }

      const payload = (await response.json()) as {
        results: { changeId: string; applied: boolean; message: string }[];
        retryResults: { changeId: string; applied: boolean; message: string }[];
        remaining: string[];
        remainingChanges: {
          id: string;
          title: string;
          summary: string;
          filePath: string;
          manualSnippet?: string;
          module?: string;
        }[];
      };
      const appliedIds = payload.results
        .filter((result) => result.applied)
        .map((result) => result.changeId);
      const appliedChanges = selectedList.filter((change) => appliedIds.includes(change.id));
      const byModule: Record<string, number> = {};
      appliedChanges.forEach((change) => {
        const key = change.module ?? "other";
        byModule[key] = (byModule[key] ?? 0) + 1;
      });
      setSummary({ appliedCount: appliedChanges.length, byModule });
      const summaryText = payload.results
        .map((result) => `${result.changeId}: ${result.applied ? "applied" : "skipped"} (${result.message})`)
        .join("\n");
      const retryText = payload.retryResults?.length
        ? `\nRetry pass:\n${payload.retryResults
            .map((result) => `${result.changeId}: ${result.applied ? "applied" : "skipped"} (${result.message})`)
            .join("\n")}`
        : "";
      if (payload.remaining.length > 0) {
        const remainingText = payload.remaining.map((id) => `remaining: ${id}`).join("\n");
        setApplyResult(`${summaryText}${retryText}\n${remainingText}`);
        setVerificationMessage(
          `Verification incomplete: ${payload.remaining.length} change(s) still pending.`
        );
        setManualSteps(payload.remainingChanges ?? []);
      } else {
        setApplyResult(`${summaryText}${retryText}\nAll suggested changes were verified.`);
        setVerificationMessage("Verification successful: all selected changes are applied.");
        setManualSteps([]);
      }
      setShowPostApplyNote(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to apply changes.");
    } finally {
      setLoading(false);
    }
  };

  const clearPlan = () => {
    setPlan(null);
    setApplyResult(null);
    setSelectedChanges({});
    setSummary(null);
    setShowPostApplyNote(false);
    setVerificationMessage(null);
  };

  const toggleChange = (id: string) => {
    setSelectedChanges((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const setAllChanges = (value: boolean) => {
    if (!plan) return;
    const next: Record<string, boolean> = {};
    plan.changes.forEach((change) => {
      next[change.id] = value;
    });
    setSelectedChanges(next);
  };

  const platformLabel = appPlatform === "flutter" ? "Flutter" : "React Native";

  return (
    <div className="app">
      <header className="hero">
        <div>
          <p className="eyebrow">Smartech SDK Integrator</p>
          <h1>Automate {platformLabel} SDK </h1>
          <p className="subtitle">
            Point the tool at a client project, choose modules, and generate a precise integration
            plan with safe edits and previews.
          </p>
          <div className="preflight-warning">
            <strong>Recommended:</strong> create a new git branch before applying changes so you can
            revert safely if needed.
          </div>
          <div className="docs-top">
            {parts.includes("base") ? (
              <div>
                <h4>Base SDK Docs</h4>
                {appPlatform === "flutter" ? (
                  <>
                    <a
                      className="doc-link"
                      href="https://developer.netcorecloud.com/docs/flutter-new-sdk-integration"
                      target="_blank"
                      rel="noreferrer"
                    >
                      Flutter SDK integration
                    </a>
                    <a
                      className="doc-link"
                      href="https://developer.netcorecloud.com/docs/flutter-new-user-event-tracking"
                      target="_blank"
                      rel="noreferrer"
                    >
                      Custom events & user tracking
                    </a>
                  </>
                ) : (
                  <>
                    <a
                      className="doc-link"
                      href="https://developer.netcorecloud.com/docs/react-native-modular-sdk-integration-user-guide"
                      target="_blank"
                      rel="noreferrer"
                    >
                      SDK integration guide
                    </a>
                    <a
                      className="doc-link"
                      href="https://developer.netcorecloud.com/docs/react-native-user-event-tracking"
                      target="_blank"
                      rel="noreferrer"
                    >
                      Custom event & user tracking
                    </a>
                  </>
                )}
              </div>
            ) : null}
            {parts.includes("push") ? (
              <div>
                <h4>Push Docs</h4>
                {appPlatform === "flutter" ? (
                  <>
                    <a
                      className="doc-link"
                      href="https://developer.netcorecloud.com/docs/flutter-new-customer-engagement"
                      target="_blank"
                      rel="noreferrer"
                    >
                      Push notification integration
                    </a>
                    <a
                      className="doc-link"
                      href="https://developer.netcorecloud.com/docs/flutter-app-inbox"
                      target="_blank"
                      rel="noreferrer"
                    >
                      App Inbox documentation
                    </a>
                    <a
                      className="doc-link"
                      href="https://developer.netcorecloud.com/docs/flutter-sdk-app-content-personalization"
                      target="_blank"
                      rel="noreferrer"
                    >
                      Content personalization
                    </a>
                    <a
                      className="doc-link"
                      href="https://developer.netcorecloud.com/docs/android-new-customer-engagement#customizing-notification-appearance"
                      target="_blank"
                      rel="noreferrer"
                    >
                      Customize notification appearance
                    </a>
                  </>
                ) : (
                  <>
                    <a
                      className="doc-link"
                      href="https://developer.netcorecloud.com/docs/android-new-customer-engagement#customizing-notification-appearance"
                      target="_blank"
                      rel="noreferrer"
                    >
                      Customize notification appearance
                    </a>
                    <a
                      className="doc-link"
                      href="https://developer.netcorecloud.com/docs/react-native-app-inbox-integration"
                      target="_blank"
                      rel="noreferrer"
                    >
                      App Inbox integration
                    </a>
                    <a
                      className="doc-link"
                      href="https://developer.netcorecloud.com/docs/app-content-personalization-react"
                      target="_blank"
                      rel="noreferrer"
                    >
                      App content personalization
                    </a>
                  </>
                )}
              </div>
            ) : null}
            {parts.includes("px") ? (
              <div>
                <h4>PX Docs</h4>
                {appPlatform === "flutter" ? (
                  <>
                    <a
                      className="doc-link"
                      href="https://developer.netcorecloud.com/docs/nudges-handling-invisible-containers"
                      target="_blank"
                      rel="noreferrer"
                    >
                      Handling invisible widget
                    </a>
                    <a
                      className="doc-link"
                      href="https://developer.netcorecloud.com/docs/nudges-on-scrollable-widgets"
                      target="_blank"
                      rel="noreferrer"
                    >
                      Handling scrollable widget
                    </a>
                  </>
                ) : (
                  <>
                    <a
                      className="doc-link"
                      href="https://developer.netcorecloud.com/docs/nudges-handling-invisible-containers-1"
                      target="_blank"
                      rel="noreferrer"
                    >
                      Handling invisible container
                    </a>
                    <a
                      className="doc-link"
                      href="https://developer.netcorecloud.com/docs/setting-up-hansel-index-for-dynamic-views"
                      target="_blank"
                      rel="noreferrer"
                    >
                      Handling dynamic views
                    </a>
                  </>
                )}
              </div>
            ) : null}
          </div>
          <div className="platforms">
            <button
              className={appPlatform === "react-native" ? "platform active" : "platform"}
              onClick={() => setAppPlatform("react-native")}
            >
              <div className="platform-title">React Native</div>
              <div className="platform-status">Active</div>
            </button>
            <div className="platform disabled">
              <div className="platform-title">Android Native</div>
              <div className="platform-status">Coming soon</div>
            </div>
            <button
              className={appPlatform === "flutter" ? "platform active" : "platform"}
              onClick={() => {
                setAppPlatform("flutter");
                setParts(["base"]);
              }}
            >
              <div className="platform-title">Flutter</div>
              <div className="platform-status">Active</div>
            </button>
          </div>
        </div>
        <div className="hero-card">
          <div className="field">
            <span className="label">Project Path</span>
            <input
              className="path-input"
              placeholder="/path/to/project"
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
            <span className="label">Custom Scheme</span>
            <input
              className="path-input"
              placeholder="your-custom-scheme"
              value={deeplinkScheme}
              onChange={(event) => setDeeplinkScheme(event.target.value)}
            />
          </div>
          <div className="field">
            <span className="label">Android Base SDK Version</span>
            <input
              className="path-input"
              placeholder="3.7.6"
              value={baseSdkVersion}
              onChange={(event) => setBaseSdkVersion(event.target.value)}
            />
          </div>
          {appPlatform === "flutter" ? (
            <div className="field">
              <span className="label">Flutter Base SDK Version</span>
              <input
                className="path-input"
                placeholder="^3.5.0"
                value={flutterBaseSdkVersion}
                onChange={(event) => setFlutterBaseSdkVersion(event.target.value)}
              />
            </div>
          ) : null}
          {appPlatform === "flutter" && (parts.includes("push") || parts.includes("px")) ? (
            <div className="field">
              <span className="label">Main Dart Path</span>
              <input
                className="path-input"
                placeholder="lib/main.dart"
                value={mainDartPath}
                onChange={(event) => setMainDartPath(event.target.value)}
              />
            </div>
          ) : null}
          <div className="field">
            <span className="label">Auto Fetch Location</span>
            <div className="toggle-row">
              <button
                className={autoFetchLocation ? "toggle active" : "toggle"}
                onClick={() => setAutoFetchLocation(true)}
              >
                Yes
              </button>
              <button
                className={!autoFetchLocation ? "toggle active" : "toggle"}
                onClick={() => setAutoFetchLocation(false)}
              >
                No
              </button>
            </div>
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
          {parts.includes("push") && appPlatform === "react-native" ? (
            <div className="push-block">
              <div className="field">
                <span className="label">Push SDK Version</span>
                <input
                  className="path-input"
                  placeholder="3.5.13"
                  value={pushSdkVersion}
                  onChange={(event) => setPushSdkVersion(event.target.value)}
                />
              </div>
              <div className="field">
                <span className="label">RN Push Library Version</span>
                <input
                  className="path-input"
                  placeholder="^3.7.2"
                  value={rnPushVersion}
                  onChange={(event) => setRnPushVersion(event.target.value)}
                />
              </div>
              <div className="field">
                <span className="label">Firebase Version</span>
                <input
                  className="path-input"
                  placeholder="^18.6.0"
                  value={firebaseVersion}
                  onChange={(event) => setFirebaseVersion(event.target.value)}
                />
              </div>
              <div className="field">
                <span className="label">Auto Ask Notification Permission</span>
                <div className="toggle-row">
                  <button
                    className={autoAskPermission ? "toggle active" : "toggle"}
                    onClick={() => setAutoAskPermission(true)}
                  >
                    Yes
                  </button>
                  <button
                    className={!autoAskPermission ? "toggle active" : "toggle"}
                    onClick={() => setAutoAskPermission(false)}
                  >
                    No
                  </button>
                </div>
              </div>
            </div>
          ) : null}
          {parts.includes("push") && appPlatform === "flutter" ? (
            <div className="push-block">
              <div className="field">
                <span className="label">Flutter Push SDK Version</span>
                <input
                  className="path-input"
                  placeholder="^3.5.0"
                  value={flutterPushSdkVersion}
                  onChange={(event) => setFlutterPushSdkVersion(event.target.value)}
                />
              </div>
              <div className="field">
                <span className="label">Android Push SDK Version</span>
                <input
                  className="path-input"
                  placeholder="3.5.13"
                  value={pushSdkVersion}
                  onChange={(event) => setPushSdkVersion(event.target.value)}
                />
              </div>
              <div className="field">
                <span className="label">Auto Ask Notification Permission</span>
                <div className="toggle-row">
                  <button
                    className={autoAskPermission ? "toggle active" : "toggle"}
                    onClick={() => setAutoAskPermission(true)}
                  >
                    Yes
                  </button>
                  <button
                    className={!autoAskPermission ? "toggle active" : "toggle"}
                    onClick={() => setAutoAskPermission(false)}
                  >
                    No
                  </button>
                </div>
              </div>
            </div>
          ) : null}
          {parts.includes("px") && appPlatform === "flutter" ? (
            <div className="push-block">
              <div className="field">
                <span className="label">Flutter PX SDK Version</span>
                <input
                  className="path-input"
                  placeholder="^1.1.0"
                  value={flutterPxSdkVersion}
                  onChange={(event) => setFlutterPxSdkVersion(event.target.value)}
                />
              </div>
              <div className="field">
                <span className="label">Android PX SDK Version</span>
                <input
                  className="path-input"
                  placeholder="10.2.12"
                  value={pxSdkVersion}
                  onChange={(event) => setPxSdkVersion(event.target.value)}
                />
              </div>
              <div className="field">
                <span className="label">Hansel App ID</span>
                <input
                  className="path-input"
                  placeholder="Your Hansel App ID"
                  value={hanselAppId}
                  onChange={(event) => setHanselAppId(event.target.value)}
                />
              </div>
              <div className="field">
                <span className="label">Hansel App Key</span>
                <input
                  className="path-input"
                  placeholder="Your Hansel App Key"
                  value={hanselAppKey}
                  onChange={(event) => setHanselAppKey(event.target.value)}
                />
              </div>
              <div className="field">
                <span className="label">PX Scheme</span>
                <input
                  className="path-input"
                  placeholder="your-custom-scheme"
                  value={pxScheme}
                  onChange={(event) => setPxScheme(event.target.value)}
                />
              </div>
            </div>
          ) : null}
          {parts.includes("px") && appPlatform === "react-native" ? (
            <div className="push-block">
              <div className="field">
                <span className="label">PX SDK Version</span>
                <input
                  className="path-input"
                  placeholder="10.2.12"
                  value={pxSdkVersion}
                  onChange={(event) => setPxSdkVersion(event.target.value)}
                />
              </div>
              <div className="field">
                <span className="label">RN PX Library Version</span>
                <input
                  className="path-input"
                  placeholder="^3.7.0"
                  value={rnPxVersion}
                  onChange={(event) => setRnPxVersion(event.target.value)}
                />
              </div>
              <div className="field">
                <span className="label">Hansel App ID</span>
                <input
                  className="path-input"
                  placeholder="Your Hansel App ID"
                  value={hanselAppId}
                  onChange={(event) => setHanselAppId(event.target.value)}
                />
              </div>
              <div className="field">
                <span className="label">Hansel App Key</span>
                <input
                  className="path-input"
                  placeholder="Your Hansel App Key"
                  value={hanselAppKey}
                  onChange={(event) => setHanselAppKey(event.target.value)}
                />
              </div>
              <div className="field">
                <span className="label">PX Scheme</span>
                <input
                  className="path-input"
                  placeholder="your-custom-scheme"
                  value={pxScheme}
                  onChange={(event) => setPxScheme(event.target.value)}
                />
              </div>
            </div>
          ) : null}
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
                  <span className="metric-value">{scanSummary?.platforms}</span>
                </div>
                <div>
                  <span className="metric-label">Planned Changes</span>
                  <span className="metric-value">{scanSummary?.changeCount}</span>
                </div>
              </div>
            </div>
            {verificationMessage ? <div className="verify-banner">{verificationMessage}</div> : null}

            <div className="panel scan-notes">
              <h3>Scan Notes</h3>
              {scanSummary?.notes.length ? (
                <ul className="notes">
                  {scanSummary.notes.map((note) => (
                    <li key={note}>{note}</li>
                  ))}
                </ul>
              ) : (
                <p className="muted">No issues detected during scan.</p>
              )}
            </div>
            {plan.changes.filter((change) => !change.patch).length > 0 ? (
              <div className="panel manual-steps">
                <h3>Manual Steps Required</h3>
                <p className="muted">
                  The tool could not safely inject the following steps. Please apply them manually.
                </p>
                <ul className="notes">
                  {plan.changes
                    .filter((change) => !change.patch)
                    .map((change) => (
                      <li key={change.id}>
                        <div className="change-title">{change.title}</div>
                        <div className="change-path">{change.filePath}</div>
                        <div className="change-summary">{change.summary}</div>
                        {change.manualSnippet ? (
                          <pre className="manual-snippet">{change.manualSnippet}</pre>
                        ) : null}
                      </li>
                    ))}
                </ul>
              </div>
            ) : null}

            <div className="panel changes-panel">
              <h3>Proposed Changes</h3>
              {plan.changes.length === 0 ? (
                <p className="muted">No changes proposed yet.</p>
              ) : (
                <div className="changes">
                  <div className="change-actions">
                    <button className="secondary" onClick={() => setAllChanges(true)}>
                      Select All
                    </button>
                    <button className="secondary" onClick={() => setAllChanges(false)}>
                      Deselect All
                    </button>
                  </div>
                  {plan.changes.map((change) => (
                    <div key={change.id} className="change">
                      <label className="change-select">
                        <input
                          type="checkbox"
                          checked={Boolean(selectedChanges[change.id])}
                          onChange={() => toggleChange(change.id)}
                        />
                        <span>Apply this change</span>
                      </label>
                      <div className="change-title">{change.title}</div>
                      <div className="change-path">{change.filePath}</div>
                      <div className="change-summary">{change.summary}</div>
                      <div className="change-meta">
                        <span>{change.kind.toUpperCase()}</span>
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
              <button className="secondary" onClick={clearPlan} disabled={loading}>
                Close Suggested Changes
              </button>
              {verificationMessage ? (
                <div className="verify-status">{verificationMessage}</div>
              ) : null}
              {applyResult ? <pre className="apply-result">{applyResult}</pre> : null}
              {showPostApplyNote ? (
                <div className="post-apply alert">
                  Please review the integration changes, run the required Gradle or Flutter sync
                  steps, and resolve any build or runtime errors before release.
                </div>
              ) : null}
            </div>
            {manualSteps.length > 0 ? (
              <div className="panel manual-steps">
                <h3>Manual Steps Required</h3>
                <p className="muted">
                  The tool could not safely inject the following steps. Please apply them manually.
                </p>
                <ul className="notes">
                  {manualSteps.map((step) => (
                    <li key={step.id}>
                      <div className="change-title">{step.title}</div>
                      <div className="change-path">{step.filePath}</div>
                      <div className="change-summary">{step.summary}</div>
                      {step.manualSnippet ? (
                        <pre className="manual-snippet">{step.manualSnippet}</pre>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {summary ? (
              <div className="panel summary-panel">
                <h3>Integration Summary</h3>
                <p className="muted">Applied changes: {summary.appliedCount}</p>
                <ul className="notes">
                  {Object.entries(summary.byModule).map(([module, count]) => (
                    <li key={module}>
                      {module.toUpperCase()}: {count} changes applied
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </section>
        )}
      </main>
    </div>
  );
}

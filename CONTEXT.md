# Smartech RN Integrator - Project Context

## Overview
This project is a local web app + local API server that scans a React Native project and generates a safe integration plan for Smartech SDK modules. It can apply changes with verification, and is designed to be extended to additional platforms (Android Native, Flutter) with the same modular rule system.

## Architecture
- Web UI (Vite + React) collects inputs and shows plan diffs, per-change toggles, apply results, verification, and docs.
- API server (Express) receives plan/apply requests and calls the integration engine.
- Integration engine (TypeScript) scans the project and produces Change objects via module rules.
- Patcher applies Change patches sequentially and writes file outputs once per file.
- After apply, the server re-plans and verifies remaining changes, with one automatic retry.

## Repo Layout
- apps/web: React UI
- apps/server: Express API server
- packages/engine: Scan, rules, patcher
- packages/shared: Shared types

## How It Works
1. UI collects inputs and selected modules.
2. UI calls POST /api/plan with rootPath, parts, inputs.
3. Engine scans project and returns a plan with Change objects.
4. UI displays each Change diff and lets the user allow or cancel per change.
5. UI calls POST /api/apply with selected changes and options.
6. Server applies changes and re-plans to verify.
7. Server retries once if any selected changes remain.
8. UI shows verification status and summary docs for selected modules.

## Running Locally
- Install dependencies: npm install
- Start server and web UI together: npm run dev

## API Endpoints
- POST /api/plan
  - body: { rootPath, parts, inputs }
  - returns: IntegrationPlan with Change[]
- POST /api/apply
  - body: { changes, selectedChangeIds, options }
  - returns: results, retryResults, remaining

## Integration Flow Details
- The engine always includes Base rules if selected in parts.
- Push/PX rules are only applied if selected or if required inputs are provided.
- Inputs are passed from UI to server to engine through IntegrationOptions.inputs.
- Each Change includes a module tag (base, push, px) for summary grouping.

## Modules and Key Rules

### Base
- Adds Smartech repo, dependencies, and gradle.properties entries.
- Injects Application onCreate init with Smartech base lines (missing-only).
- Injects MainActivity deeplink handling (missing-only).
- Adds SMT_APP_ID and SMT_IS_AUTO_FETCHED_LOCATION meta-data.
- Adds backup XMLs and manifest backup attributes with warnings.

### Push
- Adds push dependency, gradle.properties, and RN libraries.
- Adds Firebase app and messaging deps if missing.
- Injects App useEffect with token, deeplink listener, foreground handler (missing-only).
- Injects index.js background handler.
- Adds SMT_IS_AUTO_ASK_NOTIFICATION_PERMISSION meta-data.

### PX
- Adds nudges dependency, gradle.properties, and RN nudges library.
- Adds Hansel App ID and Key meta-data.
- Adds Hansel listeners in App useEffect (missing-only).
- Adds Hansel pairTestDevice call in MainActivity (after super.onCreate).
- Adds PX intent filter for the launcher activity without overwriting base intent filter.

## Patcher Behavior
- Applies unified diffs sequentially for each file using diff.applyPatch with fuzzFactor.
- Keeps per-file cache of original and current content.
- Writes each file once after all changes are applied.
- Verifies by re-planning and returns remaining change IDs.

## UI Behavior
- Per-change allow/cancel toggles.
- Apply runs verification and shows a bold status banner.
- Docs are shown based on selected modules, regardless of applied changes.
- Post-apply note reminds to sync Gradle and RN dependencies.

## Known Implementation Patterns
- Use buildChange to generate a unified diff from original and new content.
- Always check for existing code or patterns before inserting.
- Prefer missing-only insertion over replacing or removing existing code.
- Only send PX inputs if PX is selected.

## Extending to Android Native and Flutter
Recommended approach:
- Add platform selection UI with disabled placeholders for now.
- Create new rule files under packages/engine/src/rules for each platform.
- Reuse shared scan + patcher pipelines.
- Keep module boundaries consistent: base, push, px.
- Add platform-specific inputs to IntegrationOptions.inputs.

### Flutter Base (Android)
- Platform selector now supports Flutter and routes to packages/engine/src/rules/flutterBase.ts.
- Flutter currently supports Base only; Push/PX are disabled in UI and ignored in planner/server.
- Flutter inputs: flutterBaseSdkVersion, baseSdkVersion, smartechAppId, deeplinkScheme, autoFetchLocation.
- Rules handle pubspec.yaml dependency, Android repo/deps/gradle.properties, Application init, manifest meta-data,
  backup XMLs, and MainActivity deeplink handling with missing-line insertion.

## Where to Change Things
- Rule logic: packages/engine/src/rules/*.ts
- Planner: packages/engine/src/planner.ts
- Patcher: packages/engine/src/patcher.ts
- API server: apps/server/src/index.ts
- UI: apps/web/src/App.tsx
- Styles: apps/web/src/styles.css

## Troubleshooting
- If changes are missing after apply, check the Apply Results block and verification banner.
- If a change repeatedly reappears, verify that the rule detects existing code properly.
- If a file has multiple changes, ensure they are applied in a single pass (patcher handles this).

## Docs Links Used in UI
- Base SDK docs and user tracking docs are shown under Base.
- Push docs are shown under Push.
- PX docs are shown under PX.

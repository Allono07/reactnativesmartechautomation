# Smartech RN Integrator

Desktop tool (Electron + React) that generates an integration plan for Smartech SDK in React Native projects. The engine is modular, with rule-based scanners that can safely propose or apply changes.

See CONTEXT.md for full project context, architecture, and extension guidance.

## Workspace
- `apps/web`: Local web UI (Vite + React)
- `apps/server`: Local API server (Express)
- `packages/engine`: Integration planner + patcher
- `packages/shared`: Shared types

## Development
1. Install dependencies
```
npm install
```

2. Run both server + web UI
```
npm run dev
```

3. Run desktop app in local mode (no separate backend process required)
```
npm run dev:desktop
```

## Build a standalone executable (Option A)
This builds a single executable that runs the local server and opens the browser automatically.

```
npm run build:exe
```

The output binary will be in `dist/` and can be shared with non-technical users.
Double-click the executable to launch the app.

## Build Desktop App (Local, No Backend)
Build a desktop app bundle (Electron) that runs fully local:
```
npm run build:desktop
```

Platform-specific builds:
```
npm --workspace apps/desktop run dist:mac
npm --workspace apps/desktop run dist:win
npm --workspace apps/desktop run dist:linux
```

Output folder:
- `apps/desktop/release/`

Current mac output:
- `apps/desktop/release/Smartech SDK Integrator-0.1.0-arm64-mac.zip`

## Auto-Update (GitHub Releases)
You can use the same repository that contains this project; a separate repo is optional.

1. Set release repository env vars:
```
export SMARTECH_GH_OWNER=<github-owner>
export SMARTECH_GH_REPO=<github-repo>
```

2. Build with update metadata (no upload):
```
npm run build:desktop:github
```

3. Publish release assets to GitHub (requires `GH_TOKEN`):
```
export GH_TOKEN=<github-token-with-repo-scope>
npm run publish:desktop:github
```

The desktop app now checks for updates automatically on startup and then every 6 hours.

## GitHub Actions Release Automation
Workflow file:
- `.github/workflows/desktop-release.yml`

Trigger:
- Push a tag like `v0.1.1`
- Or run manually via Actions tab (`workflow_dispatch`)

This workflow builds and publishes the desktop release to GitHub Releases automatically.

## Status
- Base scan + rule stubs are in place
- Patch application is a placeholder (planned next)

# Smartech RN Integrator

Desktop tool (Electron + React) that generates an integration plan for Smartech SDK in React Native projects. The engine is modular, with rule-based scanners that can safely propose or apply changes.

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

2. Run the local API server
```
npm run dev:server
```

3. Run the web UI
```
npm run dev:web
```

## Status
- Base scan + rule stubs are in place
- Patch application is a placeholder (planned next)

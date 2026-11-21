# React + Vite

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Deployment path configuration

The dashboard's asset base path is controlled by the `VITE_BASE_PATH` environment variable, which is passed to Vite's `base` option in `vite.config.js`.

- **Root deployment** (default): leave `VITE_BASE_PATH` unset. Assets are served root-relative (e.g. `/assets/...`).
- **Subdirectory deployment**: set `VITE_BASE_PATH` to the subdirectory path, including leading and trailing slashes (e.g. `/app/`). Assets are then prefixed accordingly (e.g. `/app/assets/...`).

Example:

```bash
# Build for deployment at https://example.com/app/
VITE_BASE_PATH=/app/ npm run build
```

You can also set `VITE_BASE_PATH` in a local `.env` file (see `.env.example`). The same build can be deployed at any path by rebuilding with the appropriate value.

## Optimistic updates and server reconciliation

The payment dashboard applies optimistic mutations (e.g. creating or updating a payment) immediately in the UI, then reconciles them with the authoritative server response. The reconciliation logic lives in the dashboard data layer and follows these rules:

- **Pending mutations are centralized.** Each optimistic mutation is tracked in a single pending-mutation registry keyed by a client-generated request ID, rather than being scattered across components.
- **Request IDs guard ordering.** Every mutation and every server response carries a request ID. Responses are matched to their originating mutation, and a response is only applied if it is newer than the state currently held for that entity.
- **Out-of-order responses are ignored.** If a stale response arrives after a newer one (or after a newer optimistic mutation), it is discarded so it cannot overwrite fresher state.
- **Rollback on failure.** When a mutation fails, the optimistic change is rolled back to the last known server state. A failed payment is never left displayed as completed.
- **Cache revalidation.** After a mutation settles (success or failure), the affected cache entries are revalidated against the server so the list reflects authoritative data.
- **No duplicate entries.** Optimistic inserts are reconciled with server-returned entities by identity, so a payment that was optimistically added is not duplicated when the server response is merged into the list.

These behaviors are covered by focused tests in `src/App.test.jsx` (success, boundary, expected-failure, and concurrency/recovery cases).

## Expanding the ESLint configuration

If you are developing a production application, we recommend using TypeScript with type-aware lint rules enabled. Check out the [TS template](https://github.com/vitejs/vite/tree/main/packages/create-vite/template-react-ts) for information on how to integrate TypeScript and [`typescript-eslint`](https://typescript-eslint.io) in your project.

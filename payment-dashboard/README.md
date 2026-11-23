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

## Network safety for signing

The dashboard refuses to simulate or sign a transaction when the connected wallet's network does not match the application's configured network, or when either network is unknown.

- The provider network and passphrase are re-verified immediately before a transaction is built and signed.
- Any detected network change invalidates existing drafts, so a draft created on one network can never be signed on another.
- Simulation and signing are blocked (with a clear error) for unknown or mismatched networks.

## Pre-sign simulation review

Before any signature is requested, the dashboard runs a transaction simulation and shows a review panel with the results.

- **Simulation status**: the panel shows whether the simulation succeeded or failed. Signing is only enabled after a successful simulation of the current transaction.
- **Fee estimate**: the estimated fee is displayed and explicitly labeled as an estimate / non-final. The actual fee may differ once the transaction is submitted.
- **Actionable failures**: when the simulation fails, the panel surfaces the failure reason and any actionable details so the user can correct the transaction before signing.
- **Stale-result protection**: simulation results are bound to the specific transaction (via a fingerprint of the transaction parameters/hash). If the transaction changes after a simulation, the previous result is invalidated and cannot be used to authorize the new transaction — a fresh simulation is required.

## Resuming pending payments after reload

If the page is reloaded while a payment is in flight, the dashboard restores progress by resuming a server-side status lookup rather than resubmitting the payment.

- **Versioned reference only**: the dashboard persists only a small, versioned operation reference (an operation id plus a schema version) — never the full payment payload, amounts, or signing material.
- **Bound to account and network**: the persisted reference is stored together with the account and network it was created for. On reload it is only resumed when the currently connected account and network match; otherwise it is discarded.
- **No resubmission**: resuming performs a read-only status lookup against the server using the stored reference. The payment is never re-sent on reload.
- **Cleared on completion or mismatch**: the reference is removed once the operation reaches a terminal state (success or failure), or when it is invalid, unreadable, or does not match the current account/network.

## Theming (light / dark)

The dashboard ships accessible design tokens for both a light and a dark theme and follows the operating system preference by default, with an explicit user override that is persisted.

- **Tokens**: colors, surfaces, and contrast-sensitive values are defined as CSS custom properties under `src/styles/tokens.css` (or the equivalent token module). Each token has a light and dark value. Components must consume tokens rather than hard-coded colors so both themes stay accessible.
- **Adding a token**: define the token in the light theme block, add its dark counterpart in the dark theme block, and verify contrast (WCAG AA) in both themes. Reference the token from components via `var(--token-name)`; do not add raw color literals.
- **Pre-paint bootstrap**: a small inline script in `index.html` resolves the effective theme (stored choice, otherwise `prefers-color-scheme`) and sets the theme attribute on the root element before first paint, avoiding a flash of the wrong theme.
- **Persistence and system changes**: the user's explicit choice is stored in `localStorage` and wins over the system preference. When the user has not chosen explicitly, the dashboard tracks `prefers-color-scheme` changes live and updates the theme without a reload.

Validation:

```bash
npm run test -- --run src/theme
npm run lint
npm run build
```

## Installable PWA and offline read-only mode

The dashboard is installable and, when connectivity is lost, switches to a read-only mode backed by a service worker cache.

- **Cache allowlist**: only eligible, non-secret data is cached (e.g. static assets and read-only dashboard views). The service worker never caches API responses containing secrets, signing material, or private keys.
- **No signing material cached**: keys, seeds, and signing payloads are never written to service-worker storage or the offline cache. Offline mode is strictly read-only.
- **Freshness indicators**: cached views display when the data was last refreshed so users know they are looking at stale data.
- **Mutations disabled offline**: all write actions (payments, registration, settings changes) are disabled while offline. Financial operations are never queued for later replay; the user must reconnect and re-initiate them.
- **Recovery**: when connectivity returns, the dashboard refreshes from the network and re-enables mutations.

Validation:

```bash
npm run test -- --run src/offline src/sw
npm run lint
npm run build
```

## Bundle performance budgets

Per-route JavaScript and asset budgets are enforced in CI for the registration, history, analytics, and help routes.

- **Budgets**: thresholds for initial and compressed (gzip/brotli) sizes are defined in the budget configuration file. A build that exceeds a budget fails CI.
- **Reporting**: the budget check reports the offending route and the dependencies that contributed to the overage so the regression can be traced.
- **Updating budgets**: intentional size increases require updating the budget configuration in the same pull request, which makes the change explicit and reviewable.

Validation:

```bash
npm run build
npm run test -- --run scripts/budgets
npm run budgets
```

## Visual regression tests

Deterministic screenshots cover the registration, history, and navigation screens at mobile, tablet, and desktop sizes.

- **Determinism**: dynamic data (timestamps, random ids, live balances) is masked or stubbed so screenshots are stable across runs.
- **Minimal masking**: masking is limited to genuinely dynamic regions; layout and static content are captured unmasked.
- **Baseline approval**: when a visual change is intentional, regenerate the baselines and commit them with the pull request. Baseline updates are reviewed like code; unexplained baseline churn should be rejected.

Validation:

```bash
npm run test:visual
npm run test:visual -- --update   # regenerate baselines after an approved change
```

## Expanding the ESLint configuration

If you are developing a production application, we recommend using TypeScript with type-aware lint rules enabled. Check out the [TS template](https://github.com/vitejs/vite/tree/main/packages/create-vite/template-react-ts) for information on how to integrate TypeScript and [`typescript-eslint`](https://typescript-eslint.io) in your project.

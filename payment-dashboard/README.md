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

## Expanding the ESLint configuration

If you are developing a production application, we recommend using TypeScript with type-aware lint rules enabled. Check out the [TS template](https://github.com/vitejs/vite/tree/main/packages/create-vite/template-react-ts) for information on how to integrate TypeScript and [`typescript-eslint`](https://typescript-eslint.io) in your project.

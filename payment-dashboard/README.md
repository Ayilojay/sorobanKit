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

## Amount handling and token precision

Canonical asset amounts are kept as **exact decimal strings** end to end. Amounts are never converted to JavaScript `number`/floating point for storage, transport, or arithmetic.

- **Canonical form**: amounts are represented as decimal strings (e.g. `"12.345"`). Parsing and formatting helpers live in the amount utilities and operate on strings only.
- **Precision at the UI boundary**: token precision (decimals) is applied only when rendering or parsing user input in the UI. The canonical string is preserved unchanged in state, drafts, and requests.
- **Locale formatting**: display formatting uses `Intl.NumberFormat` with the token's precision, but the formatted output is derived from the exact string — no float round-trip. Parsing user input strips locale grouping separators and validates against the token precision before producing a canonical string.
- **Validation**: amounts exceeding the token precision or containing invalid characters are rejected with an explicit error rather than silently rounded.

Focused tests cover locale formatting, parsing, precision boundaries, and rejection of over-precision input without floating-point loss.

## Accessible confirmation dialogs

All confirmations (payment, deletion, admin actions) use the shared `Dialog` component, which implements a consistent accessibility contract:

- **Semantics**: rendered with `role="dialog"` and `aria-modal="true"`, and labelled via `aria-labelledby` (title) and optionally `aria-describedby` (description).
- **Focus entry**: on open, focus moves to the dialog (the first focusable control or the dialog container).
- **Focus trap**: Tab/Shift+Tab cycle within the dialog while it is open; focus cannot escape to the background.
- **Escape policy**: Escape closes the dialog by default. Destructive or irreversible confirmations may opt out of Escape-to-close; this is explicit per dialog and documented at the call site.
- **Focus return**: on close, focus returns to the element that opened the dialog.
- **Labelled controls**: every interactive control has an accessible name; icon-only buttons require an `aria-label`.

## Accessibility testing (WCAG 2.1 AA)

The dashboard targets **WCAG 2.1 Level AA**. Automated checks use [axe-core](https://github.com/dequelabs/axe-core) against critical journeys:

- Registration
- Payment (including pre-sign simulation review)
- Transaction history
- Analytics
- Error and loading states for each of the above

Run the focused accessibility tests with:

```bash
npm test -- --run a11y
```

Any violation fails the test. Known, reviewed exceptions are recorded in the accessibility exceptions allowlist (with a rule id, affected selector/journey, justification, and review date). Adding an exception requires review; unreviewed exceptions are not permitted.

## Reduced motion

The dashboard respects the `prefers-reduced-motion` media query:

- Nonessential animations and transitions (entrance animations, decorative motion) are disabled or simplified when reduced motion is requested.
- Functional feedback (loading indicators, state changes, focus indicators) remains visible — motion is reduced, not information removed.

Test both modes by toggling the OS/browser setting, or in Chromium DevTools via **Rendering → Emulate CSS media feature `prefers-reduced-motion`**. Automated tests cover both preference modes.

## Development commands

```bash
# Focused tests (amounts, dialogs, accessibility, reduced motion)
npm test -- --run amounts dialog a11y reduced-motion

# Lint
npm run lint

# Typecheck
npm run typecheck

# Production build
npm run build
```

## Expanding the ESLint configuration

If you are developing a production application, we recommend using TypeScript with type-aware lint rules enabled. Check out the [TS template](https://github.com/vitejs/vite/tree/main/packages/create-vite/template-react-ts) for information on how to integrate TypeScript and [`typescript-eslint`](https://typescript-eslint.io) in your project.

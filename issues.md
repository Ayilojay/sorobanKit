# Issues

## #433 Publish a state-transition specification for the payment router

This section documents the public state machine of the payment router: the
states it can occupy, the actors that drive transitions, the preconditions for
each transition, the events emitted, and the rollback behavior. Each transition
is linked to a Rust test or invariant that enforces it.

### Public state

| State | Meaning |
| --- | --- |
| `Active` | Router accepts payments and refunds; funds flow normally. |
| `Paused` | Router rejects new payments but still allows refunds and unpause. |
| `Frozen` | Router rejects payments and refunds; only governance can unfreeze. |
| `Refunded` | A payment has been fully refunded; terminal for that payment record. |

### Actors

- **Payer** — initiates payments and requests refunds.
- **Merchant / payee** — receives funds; may request refunds within policy.
- **Admin** — can pause and unpause the router.
- **Governance** — can freeze/unfreeze and execute governance-gated operations.

### Transitions

#### Payment (`Active` -> `Active`)
- **Preconditions:** router is `Active`; amount > 0; sufficient balance; payer authorized.
- **Emits:** `PaymentExecuted { payer, payee, amount }`.
- **Rollback:** on failure, no state change and no event; balances untouched.
- **Enforced by:** `test_payment_success`, `test_payment_rejects_zero_amount`,
  invariant `total_in == total_out + balance`.

#### Pause (`Active` -> `Paused`)
- **Preconditions:** caller is `Admin`; router is `Active`.
- **Emits:** `RouterPaused { by }`.
- **Rollback:** if caller is not admin, transition reverts and no event is emitted.
- **Enforced by:** `test_pause_by_admin`, `test_pause_rejects_non_admin`.

#### Unpause (`Paused` -> `Active`)
- **Preconditions:** caller is `Admin`; router is `Paused`.
- **Emits:** `RouterUnpaused { by }`.
- **Rollback:** non-admin or wrong-state calls revert with no event.
- **Enforced by:** `test_unpause_by_admin`, `test_unpause_rejects_wrong_state`.

#### Freeze (`Active` | `Paused` -> `Frozen`)
- **Preconditions:** caller is `Governance`; router is not already `Frozen`.
- **Emits:** `RouterFrozen { by }`.
- **Rollback:** non-governance calls revert; already-frozen calls are no-ops with no event.
- **Enforced by:** `test_freeze_by_governance`, `test_freeze_rejects_non_governance`.

#### Unfreeze (`Frozen` -> `Active`)
- **Preconditions:** caller is `Governance`; router is `Frozen`.
- **Emits:** `RouterUnfrozen { by }`.
- **Rollback:** non-governance or wrong-state calls revert with no event.
- **Enforced by:** `test_unfreeze_by_governance`, `test_unfreeze_rejects_wrong_state`.

#### Refund (`Active` -> `Refunded`)
- **Preconditions:** router is `Active`; payment exists and is not already refunded;
  refund amount <= original amount; caller authorized (payer or merchant within policy).
- **Emits:** `PaymentRefunded { payment_id, amount }`.
- **Rollback:** over-refund or unauthorized refund reverts; payment record unchanged.
- **Enforced by:** `test_refund_success`, `test_refund_rejects_over_amount`,
  `test_refund_rejects_unauthorized`, invariant `refunded <= paid`.

#### Governance operation
- **Preconditions:** caller is `Governance`; operation-specific guards hold.
- **Emits:** operation-specific governance event.
- **Rollback:** failed governance calls revert atomically; no partial state.
- **Enforced by:** governance tests in `contracts/governance/src/lib.rs`.

### Compatibility boundaries

- State names and event names above are part of the public contract; renaming
  them is a breaking change requiring a migration note.
- New states must be additive and must not alter existing transition preconditions.

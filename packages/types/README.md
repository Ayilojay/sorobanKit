# @refund/types

Shared TypeScript types and generated Soroban contract bindings for the refund contract.

## Smart Contract

### `get_refund_balance(user: Address, token: Address) -> i128`

Returns the refund balance for `user` in `token`.

> **Auth required:** `get_refund_balance` now calls `user.require_auth()`. Only the
> account holder (or a delegated signer) can query their own refund balance. Callers
> must supply a valid authorization entry for `user`; invoking without auth returns
> an auth error.

```ts
// The generated client requires the `user` auth entry to be present.
const balance = await contract.get_refund_balance({ user, token });
```

### `withdraw_refund` / `claim_all_refunds`

These already require auth and are unchanged.

## Versioned event schemas

Soroban events emitted by the contract are versioned so consumers can decode
payloads across contract upgrades. Each event symbol carries a `_v<N>` suffix
and the payload is a versioned struct. New versions are additive: the contract
emits the latest version, and consumers must continue to decode older versions.

### Payment events

| Symbol | Payload |
| --- | --- |
| `payment_v1` | `{ user: Address, token: Address, amount: i128 }` |
| `payment_v2` | `{ user: Address, token: Address, amount: i128, memo: Option<Bytes> }` |

### Refund events

| Symbol | Payload |
| --- | --- |
| `refund_v1` | `{ user: Address, token: Address, amount: i128 }` |
| `refund_v2` | `{ user: Address, token: Address, amount: i128, reason: Option<Bytes> }` |

### Admin / governance events

| Symbol | Payload |
| --- | --- |
| `admin_v1` | `{ action: Symbol, actor: Address }` |
| `admin_v2` | `{ action: Symbol, actor: Address, target: Option<Address> }` |

### Compatibility

- The `_v<N>` suffix is part of the event symbol; parsers should match on the
  base name and read the trailing version rather than matching exact strings.
- Payload fields are only ever added, never removed or reordered, so a decoder
  for `_v1` remains valid for `_v2` payloads (extra fields are ignored).
- Parser fixtures under the contract test suite cover both `_v1` and `_v2`
  symbols for payment, refund, and admin events.

## Regenerating bindings

After contract changes, regenerate the TypeScript bindings so the client
invocation reflects the current auth requirements and versioned event symbols.

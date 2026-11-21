# Project

## Emergency guardian (payment freeze)

Payments can be frozen by a dedicated **emergency guardian** role that is
separate from admin/owner roles.

- **May freeze payments:** the emergency guardian only. The guardian is
  narrowly scoped and **cannot** transfer funds, change policy, or modify
  configuration.
- **May unfreeze payments:** an admin/owner (policy holder). The guardian
  cannot unfreeze on its own; unfreezing requires the admin path so a single
  compromised guardian key cannot silently restore payments.
- **Rotation:** guardian rotation is delayed. A new guardian is proposed first
  and only takes effect after the timelock elapses (two-step propose/accept),
  preventing instant takeover of the freeze capability.

Operational notes:

- Freeze is fail-safe: while frozen, payment transfers are rejected.
- Guardian actions are limited to freeze; any attempt to transfer funds or
  change policy/config from the guardian role must be rejected.
- Record the proposing admin, the proposed guardian, and the activation time
  when scheduling a rotation.

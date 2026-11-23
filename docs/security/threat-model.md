# Threat Model

## Purpose and Scope

This document describes the threat model for the wallet, API, database, and contract boundaries of this system. It identifies the assets we protect, the trust boundaries between components, the capabilities we assume attackers may have, the mitigations in place, and the owners accountable for each area.

This document is intended for engineers, security reviewers, and operators. It deliberately avoids step-by-step exploit instructions; it describes classes of risk and the controls that address them so that reviewers can reason about coverage and gaps.

Out of scope: physical security of data centers, third-party SaaS internals beyond their documented guarantees, and end-user device compromise (except where it affects wallet signing assumptions).

## Assets

| Asset | Description | Sensitivity |
| --- | --- | --- |
| Wallet signing keys / material | Keys or delegated signing authority used to authorize wallet operations | Critical |
| User session tokens (JWT) | Bearer tokens granting authenticated API access | High |
| API keys | Long-lived credentials for service-to-service or programmatic access | High |
| Webhook signing secrets | Secrets used to sign and verify webhook payloads | High |
| Persisted records | User, wallet, transaction, and audit data in the database | High |
| Audit logs | Append-only record of privileged and security-relevant actions | High |
| Contract governance state | Ownership, roles, and upgrade authority for on-chain contracts | Critical |
| RPC credentials / endpoints | Access to blockchain RPC providers | Medium |
| Configuration and secrets | Environment configuration, provider credentials | High |

## Trust Boundaries

The system is decomposed into the following trust boundaries. Each boundary is a place where data or authority crosses between components with different levels of trust.

### 1. Wallet Signing Boundary

Separates the client/user intent from the signing authority that produces authorized wallet operations.

- **Crossing:** signing requests, signed payloads, key material access.
- **Assumptions:** signing keys are held only by the signing component and never exposed to the API layer or clients. Requests are authorized before signing.
- **Risks:** unauthorized signing, replay of signing requests, tampering with the payload between request and signature.

### 2. Admin Actions Boundary

Separates ordinary authenticated users from privileged administrative operations.

- **Crossing:** privileged API calls, role changes, configuration changes.
- **Assumptions:** administrative capability requires elevated authorization distinct from normal user sessions.
- **Risks:** privilege escalation, unauthorized configuration changes, abuse of admin endpoints.

### 3. Webhooks Boundary

Separates external systems (senders) from our webhook ingestion endpoints.

- **Crossing:** inbound webhook payloads and their signatures.
- **Assumptions:** external senders are untrusted until their payload signature is verified.
- **Risks:** forged payloads, replay, payload tampering, spoofed senders.

### 4. Persistence Boundary

Separates application logic from the database and stored records.

- **Crossing:** queries, writes, migrations, backups.
- **Assumptions:** the database is reachable only from trusted application components with least-privilege credentials.
- **Risks:** injection, unauthorized data access, data corruption, tampering with audit records.

### 5. RPC Boundary

Separates our services from external blockchain RPC providers.

- **Crossing:** RPC requests and responses, provider credentials.
- **Assumptions:** RPC providers are semi-trusted; responses are validated before being relied upon for state changes.
- **Risks:** malicious or faulty RPC responses, provider outage, credential leakage, denial of service.

### 6. Contract Governance Boundary

Separates off-chain operators from on-chain contract governance (ownership, roles, upgrade authority).

- **Crossing:** governance transactions, role grants, upgrades.
- **Assumptions:** governance authority is held by a controlled, auditable set of signers; changes are reviewed before execution.
- **Risks:** unauthorized upgrades, role misuse, loss of governance control, compromised governance signer.

## Attacker Capabilities

We assume attackers may have some or all of the following capabilities. Controls are designed to remain effective against realistic combinations.

- **Unauthenticated network attacker:** can send arbitrary requests to public endpoints, attempt credential stuffing, and probe for misconfiguration.
- **Authenticated low-privilege user:** holds a valid session (JWT) or API key and attempts to exceed granted privileges.
- **Credential thief:** has obtained a session token, API key, or webhook secret through leakage and attempts to use it.
- **Malicious or compromised external sender:** controls a webhook source or RPC provider and returns crafted data.
- **Insider with limited access:** has partial access to operational tooling or configuration.
- **On-chain adversary:** can attempt to interact with contracts within the permissions granted to them.

We do **not** assume attackers can break standard cryptographic primitives, nor that they have unrestricted physical or root access to production infrastructure.

## Mitigations

The following controls map to the trust boundaries above. Each control is an existing mechanism in the system.

### Authentication and Authorization

- **JWT-based sessions** authenticate users at the API boundary. Tokens are validated for signature, expiry, and audience before any action is authorized. Authorization checks are enforced server-side per endpoint, not trusted from the client.
- **API keys** authenticate programmatic/service access. Keys are scoped to least privilege and validated on every request; they are treated as secrets and never logged.
- **Admin actions** require elevated authorization distinct from ordinary sessions, and privileged endpoints enforce role checks at the boundary.

### Webhook Integrity

- **Webhook signatures** are verified on every inbound payload using the shared signing secret. Payloads that fail verification are rejected. Signature verification is performed before any side effects, and replay protection is applied to signed payloads.

### Persistence Protection

- Database access uses least-privilege credentials scoped per component. Queries are parameterized to prevent injection. **Audit logs** record privileged and security-relevant actions in an append-only manner to support detection and investigation.

### RPC Handling

- RPC responses are validated before being used to drive state changes. Provider credentials are stored as secrets and rotated. Failures and anomalous responses are surfaced to monitoring.

### Contract Governance

- **Contract governance** authority is held by a controlled set of signers with review before execution. Role grants and upgrades are auditable on-chain and cross-checked against off-chain records. Governance changes follow a documented review process.

### Cross-Cutting

- **Audit logs** provide a tamper-evident record across admin actions, signing events, and governance changes, supporting detection and post-incident review.
- Secrets (JWT signing keys, API keys, webhook secrets, RPC credentials) are managed as configuration secrets and never committed to source.

## Owners

| Area | Owner |
| --- | --- |
| Wallet signing boundary | Wallet Team |
| Admin actions boundary | Platform Security Team |
| Webhooks boundary | Integrations Team |
| Persistence boundary | Data Platform Team |
| RPC boundary | Blockchain Infrastructure Team |
| Contract governance boundary | Smart Contract Team |
| Audit logging | Platform Security Team |
| This threat model document | Security Team |

Owners are responsible for reviewing this document when their boundary changes and for ensuring the listed mitigations remain in place.

## Review and Maintenance

This threat model is reviewed at least annually and whenever a trust boundary, asset, or mitigation changes. Proposed changes to any boundary should reference this document in review. Gaps identified during review are tracked as follow-up work with an assigned owner.

## Related Documentation

- [Security overview](./README.md)
- [Contributing guide](../../CONTRIBUTING.md)
- [API documentation](../api/README.md)
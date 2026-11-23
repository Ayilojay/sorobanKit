# Security Policy

Stellar Tags is a public-facing payment platform, and we take the security of our
users and their funds seriously. This document explains which versions are
supported, how to report a vulnerability responsibly, and what you can expect
from us after you do.

## Supported Versions

Security fixes are provided for the following versions:

| Version | Supported |
| --- | --- |
| `main` (latest) | :white_check_mark: |
| Latest tagged release | :white_check_mark: |
| Older tagged releases | :x: |

If you are running a fork or an older release, please upgrade to the latest
release before reporting an issue, as it may already be fixed.

## Reporting a Vulnerability

**Please do not open a public GitHub issue, pull request, or discussion for
security vulnerabilities.** Public disclosure before a fix is available puts
users at risk.

Instead, report vulnerabilities privately using either of the following:

1. **GitHub Private Security Advisory (preferred)** — use the
   ["Report a vulnerability"](https://github.com/Stellar-Tags/Stellar-Tags/security/advisories/new)
   button on the repository's **Security** tab. This keeps the report private
   and lets us collaborate on a fix and advisory in one place.
2. **Email** — send your report to **security@stellartags.dev**.

### What to include

To help us triage quickly, please include as much of the following as possible:

- A description of the vulnerability and its potential impact.
- Steps to reproduce, or a proof-of-concept.
- Affected version, commit hash, or environment (network, browser, etc.).
- Any suggested remediation.

If you wish to encrypt your report, you may request our PGP key by email and we
will provide it before you send sensitive details.

## Response Times

We aim to meet the following commitments for all valid reports:

| Stage | Target |
| --- | --- |
| Acknowledgement of report | within **48 hours** |
| Initial assessment / triage | within **5 business days** |
| Fix or mitigation for confirmed issues | within **14 days** |
| Public disclosure (coordinated) | after a fix is released, by mutual agreement |

We will keep you informed of our progress throughout the process and credit you
in the advisory unless you prefer to remain anonymous.

## Bug Bounties

We do **not** currently operate a paid bug bounty programme. We are grateful for
responsible disclosures and will publicly credit reporters (with permission),
but we cannot offer monetary rewards at this time.

## Administrative Security Model

Administrative operations are protected by three layered controls. Reports that
show a bypass of any of these controls are treated as high severity.

### API-key rotation and revocation

- Replacement API keys are issued with a bounded overlap window. During the
  overlap, both the predecessor and successor key are valid; after the window
  closes, the predecessor is rejected immediately.
- Each key carries predecessor/successor metadata so operators can trace the
  rotation chain.
- Raw key material is displayed exactly once at issuance. It is redacted from
  all subsequent API responses, logs, and audit records.
- Revocation takes effect immediately and is recorded as an auditable event
  (who revoked, when, and which key). Revoked keys cannot be reinstated.

### Policy-based administrative roles

- Administrative capability is split into centralized read, operational, and
  configuration-changing permissions rather than a single broad admin flag.
- Every administrative route declares the permission it requires, and requests
  are authorized against that declaration.
- Sensitive administrative decisions are audited with the acting identity, the
  permission exercised, the target, and the outcome.

### Step-up verification for high-impact actions

- Contract upgrades, treasury changes, and bulk exports require a short-lived,
  single-use second confirmation bound to both the action and a hash of the
  request payload.
- Step-up confirmations expire quickly, cannot be replayed, and fail closed if
  the payload hash does not match the action being performed.
- Audit evidence for step-up decisions (challenge issuance, success, expiry, and
  failure) is retained so that sensitive actions can be reconstructed after the
  fact.

### Reporting notes for these controls

When reporting an issue in this area, please include the affected route or
operation, the role or key involved, and any step-up challenge identifiers or
timestamps you observed. Do not include raw API key material or other live
secrets in your report; redacted identifiers are sufficient.

## Scope

This policy applies to the Stellar Tags repository, including the frontend,
backend, and Soroban contracts. Vulnerabilities in third-party dependencies
should be reported upstream, though we appreciate a heads-up if they affect us.

Thank you for helping keep Stellar Tags and its users safe.

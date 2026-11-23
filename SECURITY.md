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

## Software Bill of Materials (SBOM)

Every releasable software artifact we publish — the Node.js frontend and backend
packages, the Rust/Soroban contract crates, and the container images — ships
with a [CycloneDX](https://cyclonedx.org/) Software Bill of Materials. Each SBOM
is generated automatically by the release pipeline and is tied to:

- the **source revision** (the full git commit SHA the artifact was built from), and
- the **artifact digest** (the SHA-256 digest of the published artifact or
  container image).

This lets you trace any released binary or image back to the exact source it was
built from and the exact bytes you are running.

### Obtaining SBOMs

SBOMs are attached to every GitHub release as assets alongside the artifacts
they describe. For a given release you will find one CycloneDX document per
artifact, named after the artifact and its digest. Container image SBOMs are
also published as attestations attached to the image in the registry, so they
can be retrieved with standard tooling (for example `docker buildx imagetools
inspect` or `cosign`).

### Verifying SBOMs

To verify an SBOM against an artifact:

1. Download the SBOM and the artifact from the same release.
2. Confirm the `metadata.component` and the recorded commit SHA in the SBOM
   match the release tag and the commit you expect.
3. Recompute the artifact's SHA-256 digest and confirm it matches the digest
   recorded in the SBOM. For container images, compare against the image digest
   reported by the registry.

If any of these checks fail, treat the artifact as untrusted and report it to us
privately using the process above.

### Why SBOMs matter

SBOMs give downstream consumers a complete, machine-readable inventory of the
direct and transitive dependencies bundled in each artifact. This makes it
possible to audit those dependencies for known vulnerabilities (for example by
feeding the SBOM into a vulnerability scanner or advisory database), to respond
quickly when a dependency is disclosed as vulnerable, and to meet supply-chain
compliance requirements. We encourage users and integrators to consume these
SBOMs as part of their own dependency and vulnerability management.

## Bug Bounties

We do **not** currently operate a paid bug bounty programme. We are grateful for
responsible disclosures and will publicly credit reporters (with permission),
but we cannot offer monetary rewards at this time.

## Scope

This policy applies to the Stellar Tags repository, including the frontend,
backend, and Soroban contracts. Vulnerabilities in third-party dependencies
should be reported upstream, though we appreciate a heads-up if they affect us.

## Threat Model

Our threat model documents the assets we protect, the trust boundaries between
components, the capabilities we assume of attackers, and the mitigations and
owners for each area. It covers:

- **Wallet signing** — how transaction intent is presented to and approved by
  the user's wallet, and what we assume the wallet enforces.
- **Admin actions** — privileged operations in the backend and their
  authorization and audit requirements.
- **Webhooks** — inbound and outbound event delivery, signature verification,
  and replay protection.
- **Persistence** — the database and its access controls, migrations, and
  backup/recovery expectations.
- **RPC** — how we communicate with Stellar RPC/Horizon and how we handle
  untrusted or inconsistent responses.
- **Contract governance** — the Soroban contracts, their upgrade/admin paths,
  and the trust placed in contract state.

Read the full document at [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md).

### Reporting expectations

When reporting an issue, please tell us which trust boundary or component you
believe is affected (for example, "wallet signing" or "webhooks"). This helps us
route the report to the right owner and triage it faster. Please do **not**
include working exploit code, live credentials, or instructions that could be
used to attack production users; a clear description of the impact and the
conditions required is sufficient. We will coordinate any proof-of-concept
details privately through the advisory.

Thank you for helping keep Stellar Tags and its users safe.

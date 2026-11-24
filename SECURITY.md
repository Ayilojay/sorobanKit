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

## Build Provenance Attestations

In addition to SBOMs, every backend, dashboard, and contract artifact we publish
is accompanied by a signed **build provenance attestation** in the
[SLSA provenance](https://slsa.dev/provenance) format. The attestation binds
together:

- the **source commit** (full git SHA) and repository the artifact was built
  from,
- the **workflow identity** (the GitHub Actions workflow, ref, and triggering
  event) that produced it,
- the **toolchain** (runner image, Node.js/Rust versions, and build command), and
- the **artifact digest** (SHA-256 of the published artifact or container
  image).

Attestations are generated by the release pipeline and stored as GitHub
attestations, so they can be fetched and verified with the GitHub CLI.

### Fetching and verifying provenance

To verify an artifact's provenance:

1. Download the artifact from the release you intend to run.
2. Compute its SHA-256 digest, for example:

   ```sh
   sha256sum stellar-tags-backend.tar.gz
   ```

3. Verify the attestation against the artifact and the expected source
   repository:

   ```sh
   gh attestation verify stellar-tags-backend.tar.gz \
     --repo Stellar-Tags/Stellar-Tags \
     --signer-workflow Stellar-Tags/Stellar-Tags/.github/workflows/release.yml
   ```

   For container images, verify by immutable digest rather than tag:

   ```sh
   gh attestation verify oci://ghcr.io/stellar-tags/backend@sha256:<digest> \
     --repo Stellar-Tags/Stellar-Tags
   ```

4. Confirm the reported source commit matches the commit you expect for the
   release tag, and that the reported workflow identity is the release workflow.

### What a digest mismatch means

If the digest recorded in the attestation does not match the digest of the
artifact you downloaded, **the artifact is not the one we built and must be
treated as untrusted**. Do not deploy or run it. A mismatch can indicate a
corrupted download, a mirrored or re-tagged artifact, or tampering in transit or
at rest. Re-download from the official release, re-verify, and if the mismatch
persists, stop and report it to us privately using the process above. Our own
release validation fails closed on any digest mismatch, so an artifact whose
digest does not match its attestation should never have been published.

## Container Image Signatures

Container images are signed by digest using [Sigstore](https://www.sigstore.dev/)
`cosign` in **keyless** mode. Signatures are attached to the immutable image
digest in the registry, so a signature always refers to exact bytes rather than
a mutable tag.

### Keyless signing model

We do not use long-lived repository signing keys. Instead, the release pipeline
obtains a short-lived signing certificate from Sigstore's Fulcio CA using its
**workload identity** (the GitHub Actions OIDC token), records the signature in
the Rekor transparency log, and discards the ephemeral private key immediately.
This means:

- there is no long-lived private key to leak, rotate, or revoke;
- every signature is bound to the workflow identity that produced it and is
  publicly auditable in the transparency log;
- verification checks that the signature was produced by our release workflow
  identity, not merely that *some* key signed the image.

### Verifying image signatures

Verify an image by its immutable digest, pinning the expected identity and
issuer:

```sh
cosign verify ghcr.io/stellar-tags/backend@sha256:<digest> \
  --certificate-identity-regexp '^https://github.com/Stellar-Tags/Stellar-Tags/.github/workflows/release.yml@refs/heads/main$' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

A successful verification prints the signature payload and the certificate
identity. If verification fails, or the reported identity/issuer does not match
the values above, treat the image as untrusted and do not deploy it.

### Deploy-time enforcement

Deployments pull images by digest and verify the signature before rollout. A
missing, invalid, or identity-mismatched signature fails the deployment closed;
there is no override that deploys an unverified image.

### Recovery when signing is unavailable

If Sigstore or the OIDC identity provider is unavailable during a release, the
pipeline **does not publish unsigned images as if they were signed**. Instead:

1. The release is halted and the affected images are not promoted to
   production tags.
2. Operators may continue running the last previously verified digest; no new
   digest is deployed without a valid signature.
3. Once signing is restored, the release is re-run from the same source commit
   so the published digest is signed by the release workflow identity.
4. If an emergency deploy of an already-built digest is unavoidable, it must be
   approved through the step-up verification process described below, recorded
   in the audit log with the digest and approver, and followed by a normal
   signed release as soon as signing is available.

Under no circumstances should a long-lived signing key be generated as a
workaround; doing so breaks the keyless trust model and will be treated as a
security incident.

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

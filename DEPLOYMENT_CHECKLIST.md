# Deployment Checklist

Use this checklist for every deployment. Do not skip steps.

## Build Once, Promote by Digest

- [ ] Build the backend artifact exactly once per release and record its
      immutable image digest (`sha256:...`). The same digest must be promoted
      through staging and production; never rebuild per environment.
- [ ] Confirm all environment configuration (API URLs, network passphrase,
      contract IDs, secrets, feature flags) is supplied externally via
      environment variables / secrets and is **not** baked into the image.
      Changing an environment must not require a new build.
- [ ] Record the promoted digest in the release notes / deployment record so
      staging and production can be verified as byte-identical.

## Pre-Deployment

- [ ] All changes merged to `main` and CI is green
- [ ] Version/tag decided and changelog updated
- [ ] Required secrets and environment variables are configured
- [ ] Confirm `MIGRATION_POLICY: strict` is set in `render.yaml` so production
      deploys fail fast on pending migrations instead of starting in `warn` mode
- [ ] Run the governance contract identity preflight against the candidate
      governance contract and confirm it reports the expected contract identity
      (address/version/interface) before any timelocked authority change is
      scheduled. A candidate whose interface handshake does not match the
      expected version must be rejected and must not be delegated to.
- [ ] Run the focused compatibility tests (contract interface handshake and
      API/webhook contract tests) against the candidate build and confirm they
      pass before promoting the release
- [ ] Confirm a threat-model review has been completed and recorded for any
      change touching payment settlement, webhook delivery, database failover,
      or contract pause/authority paths
- [ ] Review the incident runbooks in `docs/runbooks/` (delayed settlement,
      webhook backlog, database failover, contract pause) and confirm the
      on-call rotation has access to the linked dashboards and escalation
      contacts

## Testnet Deployment

- [ ] Push (or merge) to `main` to trigger the `deploy-testnet` workflow
- [ ] **Manual approval required:** the `deploy-testnet` workflow is gated by the
      `testnet` GitHub environment. A required reviewer must approve the run in
      the Actions UI before any deploy steps execute.
- [ ] Confirm the approval prompt appears and approve it (Actions → the running
      workflow → *Review deployments* → select `testnet` → *Approve and deploy*)
- [ ] Verify the deploy steps run only after approval
- [ ] Configure `TESTNET_API_URL` in **Settings → Secrets and variables → Actions** (or under the `testnet` environment secrets) pointing to the deployed testnet API base URL so the post-deploy `/health` verification step can confirm `200 OK` and `status: "up"`
- [ ] Smoke-test the integration environment after the deploy completes
- [ ] **Post-deploy smoke checks (#471):** run the testnet smoke checks against
      the deployed contract. They must verify the on-chain WASM hash, network,
      admin state, and read interface, and use bounded, non-duplicating test
      transactions. Publish the results keyed by the deployment ID.

> The `testnet` environment must exist in **Settings → Environments** with at
> least one required reviewer configured, and `TESTNET_API_URL` must be set as a
> required repository secret. Without them, the approval gate or post-deploy
> health check will fail.

## Preview Environments (Pull Requests)

Ephemeral preview environments are provisioned per pull request. Verify the
following before relying on a preview for review or QA:

- [ ] The preview API and dashboard are reachable at the URLs posted on the PR
- [ ] The preview uses **synthetic data only** — confirm no production data was
      copied or restored into the preview database
- [ ] The preview database is **isolated** (its own instance/schema) and cannot
      reach production databases or shared caches
- [ ] **No production credentials** are present in the preview environment;
      confirm the preview env only receives preview-scoped secrets
- [ ] A **TTL** is set on the preview environment and the expiry is visible in
      the PR comment / environment metadata
- [ ] Closing or merging the PR triggers **auditable cleanup** — confirm the
      cleanup run is recorded (logs/audit trail) and the resources are torn down

> Preview environments must never be promoted to production. If a preview
> appears to hold production credentials or data, tear it down immediately and
> rotate the affected secrets.

## Health Probes

The API exposes three probes with distinct semantics. Verify each behaves as
documented in the target environment:

- [ ] **Startup probe** — reports initialization completion only. It must not
      fail the process while startup is still in progress; slow startup must not
      be killed by the liveness probe.
- [ ] **Liveness probe** — reports process liveness only. A deadlocked process
      must fail liveness and be restarted; transient dependency outages must
      **not** fail liveness.
- [ ] **Readiness probe** — reports traffic readiness. Only dependencies that
      affect routing (e.g. the database required to serve requests) gate
      readiness; non-routing dependencies must not remove the instance from
      rotation.

- [ ] Confirm the orchestrator is configured to use the startup probe before
      liveness/readiness so slow boots are not restarted prematurely
- [ ] Confirm readiness failures remove the instance from traffic without
      restarting it, and liveness failures trigger a restart

## Post-Deployment

- [ ] Verify the deployed version/commit and image digest match the intended
      release and the recorded deployment identity
- [ ] Confirm the post-deploy smoke-check results are published and keyed by
      the deployment ID, and that the on-chain WASM hash matches the release
      manifest
- [ ] Monitor logs and metrics for errors
- [ ] Notify the team that the deployment is complete
- [ ] If a rollback is required, follow the rollback procedure in the relevant
      runbook under `docs/runbooks/` rather than improvising steps

## Local Development Bootstrap

- [ ] For local verification, use the one-command bootstrap
      (`scripts/bootstrap.sh` or the documented `make bootstrap` target) instead
      of manual service setup. It validates tool versions, starts isolated
      services, applies migrations, and reports readiness, and fails with
      actionable prerequisite messages. It must never target production
      resources.

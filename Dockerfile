# syntax=docker/dockerfile:1.7

# =============================================================================
# Reproducible container builds
# =============================================================================
# Reproducibility contract
# ------------------------
# * Every base image is pinned by tag AND digest (`image:tag@sha256:...`). The
#   tag is kept for readability only; the digest is authoritative. Builds must
#   never resolve a floating tag.
# * Build and runtime stages are strictly separated. Build-only toolchains
#   (python3, make, g++, linux-headers, libusb-dev, eudev-dev, npm caches) and
#   dev dependencies never reach the final `backend` / `frontend` stages.
# * No credentials, tokens, or `.env` files are copied into any stage. Secrets
#   must be supplied at runtime (env/secret mounts), never baked into layers.
# * `npm ci` is used with the committed lockfiles so dependency resolution is
#   deterministic. `NPM_CONFIG_*` env vars below keep network retries stable.
#
# Updating a pinned digest (reviewed procedure)
# ---------------------------------------------
# 1. Resolve the new digest for the desired tag, e.g.:
#      docker buildx imagetools inspect node:26-alpine
#      docker buildx imagetools inspect nginx:alpine
#    (or `crane digest node:26-alpine` / `skopeo inspect --format '{{.Digest}}'`).
# 2. Update the corresponding `ARG ..._IMAGE` default below with the new
#    `tag@sha256:<digest>` value. Change one image per pull request.
# 3. Re-run the focused build and image-content checks (see CONTRIBUTING /
#    docs) to confirm the image still builds and contains no build-only tools.
# 4. Record the old -> new digest and the reason (CVE fix, upstream release) in
#    the pull request description so the bump is reviewed.
#
# The digests below are placeholders that MUST be replaced with real values via
# the procedure above before a release build; CI verifies they are pinned.
# =============================================================================

ARG NODE_IMAGE=node:26-alpine@sha256:0000000000000000000000000000000000000000000000000000000000000000
ARG NGINX_IMAGE=nginx:alpine@sha256:0000000000000000000000000000000000000000000000000000000000000000

# --- Shared build base (build stages only; never a runtime stage) ---
FROM ${NODE_IMAGE} AS base
WORKDIR /app
ENV NPM_CONFIG_AUDIT=false \
	NPM_CONFIG_FUND=false \
	NPM_CONFIG_FETCH_RETRIES=5 \
	NPM_CONFIG_FETCH_RETRY_MINTIMEOUT=20000 \
	NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT=120000 \
	NPM_CONFIG_FETCH_TIMEOUT=600000

# --- SBOM metadata ---
# Container SBOMs (SPDX/CycloneDX) are NOT generated inside this Dockerfile.
# They are produced externally by running `syft` against the built image digest,
# e.g.:
#   syft <registry>/<image>@sha256:<digest> -o spdx-json > sbom.spdx.json
#   syft <registry>/<image>@sha256:<digest> -o cyclonedx-json > sbom.cdx.json
# The OCI labels below (revision = git SHA, source = repo URL) tie each SBOM
# back to the exact source revision and artifact digest. Pass them at build time:
#   docker build \
#     --build-arg GIT_REVISION=$(git rev-parse HEAD) \
#     --build-arg SOURCE_URL=https://github.com/<org>/<repo> \
#     -t <image> .
ARG GIT_REVISION=unknown
ARG SOURCE_URL=unknown

# --- Backend build (build-only: dev deps + prisma CLI live here) ---
FROM base AS backend-build
ARG GIT_REVISION
ARG SOURCE_URL
LABEL org.opencontainers.image.revision=$GIT_REVISION \
	org.opencontainers.image.source=$SOURCE_URL
COPY stellar-payment-platform/package*.json ./
COPY stellar-payment-platform/prisma ./prisma
RUN npm ci --no-audit --no-fund
COPY stellar-payment-platform/ .
RUN npx prisma generate

# --- Backend runtime (no build tools, no dev deps, no credentials) ---
FROM ${NODE_IMAGE} AS backend
ARG GIT_REVISION
ARG SOURCE_URL
LABEL org.opencontainers.image.revision=$GIT_REVISION \
	org.opencontainers.image.source=$SOURCE_URL
WORKDIR /app
ENV NODE_ENV=production \
	NPM_CONFIG_AUDIT=false \
	NPM_CONFIG_FUND=false
# Copy only the application source and generated Prisma client from the build
# stage. Dev dependencies and toolchains stay behind in `backend-build`.
COPY --from=backend-build /app/package*.json ./
COPY --from=backend-build /app/node_modules ./node_modules
COPY --from=backend-build /app/prisma ./prisma
COPY --from=backend-build /app/server.js ./
EXPOSE 5000
USER node
CMD ["node", "server.js"]

# --- Frontend build (build-only: native toolchain + dev deps live here) ---
FROM base AS frontend-build
ARG GIT_REVISION
ARG SOURCE_URL
LABEL org.opencontainers.image.revision=$GIT_REVISION \
	org.opencontainers.image.source=$SOURCE_URL
COPY payment-dashboard/package*.json ./
RUN apk add --no-cache python3 make g++ linux-headers libusb-dev eudev-dev
RUN npm ci --registry=https://registry.yarnpkg.com/ --no-audit --no-fund --fetch-retries=5 --fetch-retry-mintimeout=20000 --fetch-retry-maxtimeout=120000 --fetch-timeout=600000
COPY payment-dashboard/ .
ARG VITE_API_BASE=http://localhost:5000
ENV VITE_API_BASE=$VITE_API_BASE
RUN npm run build

# --- Frontend serve (runtime only: static assets + nginx config) ---
FROM ${NGINX_IMAGE} AS frontend
ARG GIT_REVISION
ARG SOURCE_URL
LABEL org.opencontainers.image.revision=$GIT_REVISION \
	org.opencontainers.image.source=$SOURCE_URL
# Only the compiled static bundle and nginx config are copied; no node_modules,
# no build toolchain, and no source or credentials reach this stage.
COPY --from=frontend-build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
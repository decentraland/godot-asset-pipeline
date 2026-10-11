# asset-optimizer: Node worker + the godot-explorer headless asset server.
#
# Build context is the repo root. CI builds it with decentraland/platform-actions
# (apps-pr / apps-docker-next / apps-docker-release), which pass COMMIT_HASH and
# CURRENT_VERSION as build args. Single-arch: the godot binary is x86_64 only,
# so build locally with `docker build --platform linux/amd64 .`.

# godot-explorer base, pinned to an IMMUTABLE commit-sha tag (never :next or
# :latest; quay garbage-collects digests that were only reachable through a
# moving tag). The optimized output depends on this engine version, so bump it
# deliberately and together with S3_PREFIX when the output format changes.
# c616fb7c... = godot-explorer release 1.14.1 (the digest `latest` points to).
ARG GODOT_IMAGE=quay.io/decentraland/godot-explorer:c616fb7c1061ce27f9de5a5cbd3c581c33eb768a
ARG NODE_IMAGE=node:24-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20

########################## BUILD STAGE ##########################
FROM ${NODE_IMAGE} AS builder

WORKDIR /service

COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile

COPY . .
RUN yarn build
RUN yarn test
RUN yarn install --prod --frozen-lockfile

########################## RUNTIME STAGE ##########################
FROM ${GODOT_IMAGE}

USER root

# The godot-explorer base ships Xvfb, Ubuntu's nodejs/npm and a global
# @gltf-transform/cli (godot shells out to it while baking).
# - x11-utils provides xdpyinfo (entrypoint's Xvfb readiness probe) and
#   mesa-utils provides glxinfo (entrypoint's GL-renderer sanity print).
#   Without them the readiness probe never succeeds and the container
#   crash-loops on "Xvfb never came up".
# - Node 24 comes from nodesource (replaces the distro nodejs/npm packages).
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        tini \
        x11-utils \
        mesa-utils && \
    curl -fsSL https://deb.nodesource.com/setup_24.x -o /tmp/nodesource_setup.sh && \
    bash /tmp/nodesource_setup.sh && \
    rm -f /tmp/nodesource_setup.sh && \
    apt-get install -y --no-install-recommends nodejs && \
    node --version && \
    rm -rf /var/lib/apt/lists/* /var/cache/apt/*

# The upstream godot-explorer image ships @gltf-transform/cli with sharp's
# libvips (@img/sharp-libvips-linux-x64) but WITHOUT sharp's native binding
# (@img/sharp-linux-x64), so every gltf-transform invocation died with
# 'Could not load the "sharp" module using the linux-x64 runtime' and the
# asset server dropped the asset. Add the binding that matches the installed
# sharp version, straight from the npm tarball (no dependency re-resolution),
# and fail the build if the CLI still does not start. No-op when the base
# image already ships a working binding.
RUN set -eu; \
    cli=/usr/local/lib/node_modules/@gltf-transform/cli; \
    if [ -d "${cli}" ] && ! node -e "require('${cli}/node_modules/sharp')" >/dev/null 2>&1; then \
      ver="$(node -p "require('${cli}/node_modules/sharp/package.json').version")"; \
      tmp="$(mktemp -d)"; cd "${tmp}"; \
      npm pack --silent "@img/sharp-linux-x64@${ver}" >/dev/null; \
      mkdir -p "${cli}/node_modules/@img/sharp-linux-x64"; \
      tar -xzf img-sharp-linux-x64-*.tgz --strip-components=1 -C "${cli}/node_modules/@img/sharp-linux-x64"; \
      cd /; rm -rf "${tmp}"; \
      echo "installed @img/sharp-linux-x64@${ver} for @gltf-transform/cli"; \
    fi; \
    if [ -d "${cli}" ]; then node -e "require('${cli}/node_modules/sharp')" && gltf-transform --version; fi

ENV NODE_ENV=production
# Port of the godot asset server (the Node HTTP server defaults to 5000).
ENV ASSET_SERVER_PORT=8080

# Node app lives in /service: /app belongs to the godot-explorer files
# (/app/decentraland.godot.client.x86_64).
WORKDIR /service
COPY --from=builder /service/package.json /service/.env.default ./
COPY --from=builder /service/node_modules ./node_modules
COPY --from=builder /service/dist ./dist
# Real configuration comes from the ECS task environment (definitions); an
# empty .env only silences the dotenv "file not found" warning.
RUN echo "" >> .env

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ARG COMMIT_HASH=local
ARG CURRENT_VERSION=Unknown
ENV COMMIT_HASH=${COMMIT_HASH:-local}
ENV CURRENT_VERSION=${CURRENT_VERSION:-Unknown}

# No HEALTHCHECK / EXPOSE: the port (HTTP_SERVER_PORT, 5000) and the
# /health/live check are declared by the ECS service in definitions.
#
# tini is PID 1 and forwards SIGTERM to node (entrypoint.sh execs it), so the
# worker can release its in-flight SQS message on stop. Read more:
# https://aws.amazon.com/blogs/containers/graceful-shutdowns-with-ecs/
ENTRYPOINT ["/usr/bin/tini", "--", "/entrypoint.sh"]

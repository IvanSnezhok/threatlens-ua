# The deployment runner: the one container in this stack that may hold the host's Docker socket.
#
# Build context is the REPOSITORY ROOT (`compose.yaml` sets `context: .`), because the runner's
# TypeScript lives in the ordinary source tree at `src/deployer/**`. That placement is deliberate:
# code that can restart the production stack must be covered by the project's own typecheck, lint and
# unit tests, and a separate mini-project beside the repository would be covered by none of them.
# What keeps it isolated is `eslint.config.js`, which lets `src/deployer/**` import `node:*`, `pg` and
# `zod` and nothing else — so this image needs no part of the application's runtime.
#
# It runs as ROOT, and that is stated rather than worked around. `/var/run/docker.sock` is owned by
# `root:docker`; a non-root user would need the `docker` group, and membership of that group is
# equivalent to root on the host anyway. Pretending otherwise with a USER line would buy nothing and
# would hide the actual trust boundary, which is the bearer token and the frozen scenario — see
# `docs/OPERATIONS.md`, "Deployment from /ops".

FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN apk add --no-cache --virtual .build-deps python3 make g++ \
    && npm ci \
    && apk del .build-deps
COPY tsconfig.json ./
COPY src ./src
# The ROOT tsconfig, the same one `npm run build` and `npm run typecheck` use. Only `dist/deployer`
# is copied into the runtime stage below, so the application's compiled output never ships here —
# but compiling it is what proves the runner was built from a tree that typechecks as a whole.
RUN npx tsc -p tsconfig.json

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# git drives the checkout; docker-cli and docker-cli-compose drive the stack through the mounted
# socket; ca-certificates is what makes the HTTPS fetch of origin/main verifiable. Nothing else: this
# image has no shell surface it needs beyond what these four provide.
RUN apk add --no-cache git docker-cli docker-cli-compose ca-certificates
COPY package*.json ./
RUN apk add --no-cache --virtual .build-deps python3 make g++ \
    && npm ci --omit=dev \
    && apk del .build-deps
COPY --from=build /app/dist/deployer ./dist/deployer
# `expose` in compose.yaml, never `ports`: reachable on the compose network and from nowhere else.
EXPOSE 9000
CMD ["node", "dist/deployer/index.js"]

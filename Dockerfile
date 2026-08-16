FROM node:24.18.0-bookworm-slim AS build
WORKDIR /workspace
COPY package.json LICENSE ./
COPY pnpm-lock.yaml ./
# Corepack resolves the exact packageManager version from package.json.
RUN corepack enable pnpm && corepack install
# The runtime build is dependency-free; install exactly the production closure
# from the lockfile so no development tooling can reach the final image.
RUN test "$(pnpm --version)" = "10.33.4" \
  && pnpm install --prod --frozen-lockfile --ignore-scripts
COPY contracts ./contracts
COPY protocol ./protocol
COPY packages ./packages
COPY scripts ./scripts
COPY src ./src
RUN node scripts/build.mjs

FROM node:24.18.0-bookworm-slim AS runtime
WORKDIR /app
COPY --from=build --chown=node:node /workspace/dist ./dist
COPY --from=build --chown=node:node /workspace/node_modules ./node_modules
USER node
EXPOSE 8080
CMD ["node", "dist/src/server.mjs"]

FROM node:24.18.0-bookworm-slim AS build
WORKDIR /workspace
COPY package.json LICENSE ./
COPY package-lock.json ./
# The runtime build is dependency-free; install exactly the production closure
# from the lockfile so no development tooling can reach the final image.
RUN npm ci --omit=dev --ignore-scripts
COPY contracts ./contracts
COPY protocol ./protocol
COPY packages ./packages
COPY scripts ./scripts
COPY src/*.mjs ./src/
RUN node scripts/build.mjs

FROM node:24.18.0-bookworm-slim AS runtime
WORKDIR /app
COPY --from=build --chown=node:node /workspace/dist ./dist
COPY --from=build --chown=node:node /workspace/node_modules ./node_modules
USER node
EXPOSE 8080
CMD ["node", "dist/src/server.mjs"]

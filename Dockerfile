FROM node:24.18.0-bookworm-slim AS build
WORKDIR /workspace
COPY package.json LICENSE ./
COPY contracts ./contracts
COPY scripts/build.mjs ./scripts/build.mjs
COPY src/*.mjs ./src/
RUN node scripts/build.mjs

FROM node:24.18.0-bookworm-slim AS runtime
WORKDIR /app
COPY --from=build --chown=node:node /workspace/dist ./
USER node
EXPOSE 8080
CMD ["node", "src/server.mjs"]

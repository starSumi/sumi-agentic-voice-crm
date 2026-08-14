FROM node:20-bookworm-slim
WORKDIR /app
COPY package.json .
COPY src ./src
COPY contracts ./contracts
COPY scripts ./scripts
COPY docs ./docs
COPY README.md AGENTS.md LICENSE ./
RUN npm run check && npm run build
USER node
EXPOSE 8080
CMD ["node", "src/server.mjs"]

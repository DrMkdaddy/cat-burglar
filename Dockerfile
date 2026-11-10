FROM node:24-bookworm AS build
WORKDIR /app
RUN npm install -g pnpm@12.17.0
COPY package.json pnpm-lock.yaml ./
RUN PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
RUN pnpm run build && pnpm prune --prod

FROM node:24-bookworm-slim
LABEL io.modelcontextprotocol.server.name="io.github.DrMkdaddy/cat-burglar"
RUN apt-get update \
  && apt-get install -y --no-install-recommends chromium fonts-liberation ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json README.md LICENSE NOTICE ./
ENV BROWSER_MCP_CHROMIUM_PATH=/usr/bin/chromium
ENV BROWSER_MCP_NO_SANDBOX=1
USER node
ENTRYPOINT ["node", "dist/index.js"]

# The agentbox server in a container. It needs the Docker socket, since sandboxes are started through
# it, and a volume at /data for the SQLite file. Run it with --network host so it stays on the host's loopback.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json tsconfig.build.json ./
RUN npm ci
COPY src ./src
COPY sdk/src ./sdk/src
COPY mcp ./mcp
COPY proxy ./proxy
COPY scripts ./scripts
RUN npm run build

FROM node:22-bookworm-slim
WORKDIR /app
# openssl generates the egress proxy's CA, which the server owns and pushes to the proxy.
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY bin ./bin
ENV AGENTBOX_DB=/data/agentbox.db
VOLUME /data
EXPOSE 7788
CMD ["node", "bin/agentbox.js", "serve"]

# Node 22, npm and git on top of the agentbox base image, for TypeScript and JavaScript work.
# Build: npm run agentbox -- template build node templates/node/Dockerfile
FROM python:3.12-slim
COPY --from=node:22-slim /usr/local/bin/node /usr/local/bin/node
COPY --from=node:22-slim /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -s /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
 && apt-get update && apt-get install -y --no-install-recommends git \
 && rm -rf /var/lib/apt/lists/*
# npm's cache goes to /tmp, not into the workspace. Node's fetch honours HTTP_PROXY only with this flag.
ENV npm_config_cache=/tmp/npm-cache NODE_USE_ENV_PROXY=1

# The agentbox server in a container. It needs the Docker socket, since sandboxes are started through
# it, and a volume at /data for the SQLite file. Run it with --network host so it stays on the host's loopback.
FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY proxy ./proxy
ENV AGENTBOX_DB=/data/agentbox.db
VOLUME /data
EXPOSE 7788
CMD ["node", "--import", "tsx", "src/main.ts"]

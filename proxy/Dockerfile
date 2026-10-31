FROM node:20-alpine
RUN apk add --no-cache openssl ca-certificates
WORKDIR /proxy
COPY policy.mjs certs.mjs server.mjs main.mjs ./
USER node
CMD ["node", "main.mjs"]

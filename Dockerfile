# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e

FROM node:24-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43 AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --no-audit --no-fund

FROM dependencies AS build
COPY . .
RUN npm run build

FROM node:24-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43 AS production-dependencies
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --no-audit --no-fund \
    && npm pkg delete devDependencies \
    && npm cache clean --force

FROM node:24-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43 AS runtime
LABEL org.opencontainers.image.title="Page2Knowledge" \
      org.opencontainers.image.description="Source-aware local knowledge package service" \
      org.opencontainers.image.version="0.2.1" \
      org.opencontainers.image.source="https://github.com/mason2048/page2knowledge" \
      org.opencontainers.image.licenses="Apache-2.0"

ENV NODE_ENV=production \
    PAGE2KNOWLEDGE_PORT=4315 \
    PAGE2KNOWLEDGE_DATA_DIR=/data \
    PAGE2KNOWLEDGE_KNOWLEDGE_PATH=/data/knowledge-store.json \
    PAGE2KNOWLEDGE_SCHEDULER_PATH=/data/scheduler-state.json

WORKDIR /app
RUN mkdir -p /data \
    && chown node:node /data \
    && chmod 0700 /data

COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=production-dependencies --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/LICENSE ./LICENSE
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/dist-server ./dist-server
COPY --from=build --chown=node:node /app/samples ./samples
# Keep assets discoverable both from cwd and relative to compiled server/index.js.
RUN ln -s ../dist /app/dist-server/dist \
    && ln -s ../samples /app/dist-server/samples

USER node
EXPOSE 4315
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
  CMD ["node", "-e", "const port=process.env.PAGE2KNOWLEDGE_PORT||'4315';fetch('http://127.0.0.1:'+port+'/api/health').then(r=>{if(!r.ok)throw new Error(String(r.status))}).catch(()=>process.exit(1))"]

# npm prestart and the application independently enforce the same trimmed
# UTF-8 byte-length rule. Start Node directly after the preflight so it is PID 1.
CMD ["sh", "-c", "npm run prestart && exec node dist-server/server/index.js"]

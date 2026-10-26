FROM node:24-alpine AS runner

ENV NODE_ENV=production
WORKDIR /app

# Install deps first so this layer caches across source-only changes
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY agent ./agent

# The only writable path: memory, transcripts and the people registry live here
RUN mkdir -p /app/data && chown node:node /app/data

# Drop root — the bot needs no privileges and no ports, and writes only to /app/data
USER node

# --import loads the telemetry bootstrap (OTel tracing + Pyroscope) before the
# app, so auto-instrumentation can patch http/fetch. All exporters are opt-in
# behind env vars, so this is a no-op until the Grafana stack endpoints are set.
CMD ["node", "--import", "./src/telemetry.js", "src/index.js"]

FROM node:24.15.0-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/dashboard/package.json apps/dashboard/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/geo/package.json packages/geo/package.json
COPY packages/schemas/package.json packages/schemas/package.json
COPY services/discovery/package.json services/discovery/package.json
COPY services/worker/package.json services/worker/package.json
RUN npm ci --ignore-scripts

FROM node:24.15.0-bookworm-slim AS builder
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json tsconfig.json tsconfig.container.json ./
COPY packages/schemas/src ./packages/schemas/src
COPY scripts/sample.ts ./scripts/sample.ts
RUN ./node_modules/.bin/tsc --project tsconfig.container.json

FROM node:24.15.0-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=builder --chown=node:node /app/dist ./dist
USER node
HEALTHCHECK NONE
CMD ["node", "dist/scripts/sample.js"]

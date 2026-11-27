FROM node:lts-alpine AS builder

USER node
WORKDIR /app
COPY --chown=node:node app/ ./
COPY --chown=node:node static/ ./static/

RUN npm ci \
    && npx tsc

FROM node:lts-alpine AS runner

USER node
WORKDIR /app
COPY --from=builder --chown=node:node app/ ./

RUN npm ci --omit=dev

ARG PACKAGE_VERSION
ENV APP_VERSION=${PACKAGE_VERSION}
ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD wget -qO- http://127.0.0.1:${PORT}/health || exit 1

CMD ["node", "dist/index.js" ]

FROM node:22.23.3-bookworm@sha256:c4d5523090a817b7aa86d2111241fdd4f66d1e27782b44160e6aa63b357ecb2d AS build
WORKDIR /build
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY src ./src
COPY bin ./bin
COPY migrations ./migrations
COPY scripts ./scripts
COPY deploy ./deploy
COPY docs ./docs
COPY README.md LICENSE ./
RUN test ! -e src/capture/.env && test ! -e src/capture/.handoff && test ! -e src/capture/.codex
RUN npm run build && npm pack --ignore-scripts --pack-destination /tmp

FROM node:22.23.3-bookworm@sha256:c4d5523090a817b7aa86d2111241fdd4f66d1e27782b44160e6aa63b357ecb2d AS dependencies
WORKDIR /opt/continuum
COPY --from=build /tmp/*.tgz /tmp/package.tgz
RUN tar -xzf /tmp/package.tgz --strip-components=1 && rm /tmp/package.tgz
COPY package-lock.json ./package-lock.json
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && rm package-lock.json && \
    find node_modules -type f \( -name '*.map' -o -name '*.test.*' -o -name '*.spec.*' \) -delete && \
    chmod -R a-w /opt/continuum

FROM node:22.23.3-bookworm-slim@sha256:efd0ab5780c2d9ab1f0f869571a00d5edb17793bff4cce4a2792e3eb0ffc7562 AS runtime
ARG SOURCE_SHA
ARG SOURCE_DATE_EPOCH
LABEL org.opencontainers.image.title="Continuum" \
      org.opencontainers.image.source="https://github.com/nucleoid/continuum" \
      org.opencontainers.image.revision="${SOURCE_SHA}"
ENV NODE_ENV=production
WORKDIR /opt/continuum
COPY --from=dependencies --chown=0:0 /opt/continuum ./
RUN chmod a-w /opt/continuum && \
    ln -s /opt/continuum/bin/continuum.mjs /usr/local/bin/continuum && \
    ln -s /opt/continuum/bin/continuum-tags.mjs /usr/local/bin/continuum-tags && \
    ln -s /opt/continuum/bin/continuum-migrate.mjs /usr/local/bin/continuum-migrate
USER 10001:10001
EXPOSE 4000
ENTRYPOINT ["node", "/opt/continuum/deploy/container-entrypoint.mjs"]
CMD ["node", "dist/api/server.js"]

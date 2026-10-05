# syntax=docker/dockerfile:1

# ---- 1. Compile the C++ engine to WebAssembly ---------------------------
FROM emscripten/emsdk:6.0.11 AS build
WORKDIR /src
COPY Makefile ./
COPY engine/ engine/
COPY web/ web/
RUN make build

# ---- 2. Small runtime image: Node.js with no npm packages -----------------
FROM node:24-alpine

# npm/yarn are not needed at runtime; removing them shrinks the attack surface.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx \
           /opt/yarn* /usr/local/bin/yarn /usr/local/bin/yarnpkg

ENV NODE_ENV=production \
    PUBLIC_DIR=/app/public \
    PORT=8080

WORKDIR /app
# Files stay owned by root, so the app (running as "node") cannot modify itself.
COPY server/package.json server/index.mjs ./server/
COPY server/src/ ./server/src/
COPY --from=build /src/build/public/ ./public/

USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
    CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
CMD ["node", "server/index.mjs"]

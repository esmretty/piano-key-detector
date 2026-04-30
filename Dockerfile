# syntax=docker/dockerfile:1.7
#
# Slim app image. All the heavy stuff (Audiveris, Oemer, Python venv, ML
# checkpoints) lives in the base image, built separately by build-base.yml.
# This Dockerfile only adds the frontend bundle and the backend Node app,
# which keeps day-to-day deploys to ~50 MB of new layers and 1–2 minutes.
#
# To rebuild the base image, edit Dockerfile.base and push — that triggers
# build-base.yml. To pin to a specific base version, override BASE_IMAGE.

ARG BASE_IMAGE=asia-east1-docker.pkg.dev/piano-key-detector/piano-base/runtime:latest


# ---- Stage 1: build the Vite frontend --------------------------------------
FROM node:22-slim AS fe-builder
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build


# ---- Stage 2: app runtime --------------------------------------------------
FROM ${BASE_IMAGE}

WORKDIR /app
COPY backend/package*.json backend/
RUN cd backend && npm ci --omit=dev

COPY backend/ backend/
COPY --from=fe-builder /app/frontend/dist /app/frontend/dist

ENV PORT=3001 \
    OMR_ENGINE=auto

EXPOSE 3001

# tini = proper PID 1 so SIGTERM from Cloud Run cleanly stops the worker subprocess
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "backend/server.js"]

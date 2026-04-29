# syntax=docker/dockerfile:1.7

# ============================================================================
# Stage 1: build the Vite frontend
# ============================================================================
FROM node:22-slim AS fe-builder
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build


# ============================================================================
# Stage 2: download Audiveris .deb (Ubuntu 24.04 build, has bundled JRE)
# ============================================================================
FROM debian:bookworm-slim AS audi-fetch
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && \
    rm -rf /var/lib/apt/lists/*
RUN curl -L --retry 3 -o /tmp/audiveris.deb \
    https://github.com/Audiveris/audiveris/releases/download/5.10.2/Audiveris-5.10.2-ubuntu24.04-x86_64.deb


# ============================================================================
# Stage 3: runtime
# ============================================================================
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

# OS deps:
#   ca-certificates, curl   → general
#   libgl1, libglib2.0-0    → opencv (used by Oemer) + Audiveris's image libs
#   tesseract-ocr           → Audiveris OCR for lyrics (optional but stops warnings)
#   poppler-utils           → some PDF tooling
#   libxml2-utils, libxext6 → Audiveris swing
#   python3, pip            → Oemer fallback
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      gnupg \
      libgl1 \
      libglib2.0-0 \
      libxml2-utils \
      libxext6 \
      libxrender1 \
      libxtst6 \
      libfreetype6 \
      libfontconfig1 \
      tesseract-ocr \
      tesseract-ocr-eng \
      poppler-utils \
      python3 \
      python3-pip \
      python3-venv \
      tini \
    && rm -rf /var/lib/apt/lists/*

# Node 22
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && \
    apt-get install -y --no-install-recommends nodejs && \
    rm -rf /var/lib/apt/lists/*

# Audiveris (.deb bundles its own JRE).
# Pre-create the dirs that audiveris's post-install xdg-desktop-menu hook
# wants to write to — without them it errors and dpkg refuses the install.
# Then list everything dpkg installed so we know the exact CLI path.
COPY --from=audi-fetch /tmp/audiveris.deb /tmp/audiveris.deb
RUN mkdir -p /usr/share/applications /usr/share/desktop-directories /usr/share/icons/hicolor && \
    apt-get update && \
    apt-get install -y /tmp/audiveris.deb && \
    rm -rf /var/lib/apt/lists/* /tmp/audiveris.deb && \
    dpkg -L audiveris | grep -E '/(audiveris|Audiveris)(\.sh)?$' || \
      (echo "===== audiveris install layout =====" && dpkg -L audiveris | head -40 && false)

# Python venv with Oemer (CPU only — no nvidia wheels)
RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:${PATH}"
RUN pip install --no-cache-dir oemer onnxruntime

# Pre-warm Oemer's Python imports so first request isn't a 30-second cold-start.
# Model checkpoints are downloaded on first inference; can't pre-download
# without running on a real image, so we accept that cost on first OMR call.
RUN python -c "import oemer.ete; print('oemer ete imported')"

# App
WORKDIR /app
COPY backend/package*.json backend/
RUN cd backend && npm ci --omit=dev

# Bring in source AFTER deps so changes don't bust the npm cache.
COPY backend/ backend/
COPY --from=fe-builder /app/frontend/dist /app/frontend/dist

ENV NODE_ENV=production \
    PORT=3001 \
    OMR_ENGINE=auto \
    AUDIVERIS_EXE=/opt/audiveris/bin/Audiveris \
    PYTHON_BIN=/opt/venv/bin/python \
    OEMER_BIN=/opt/venv/bin/oemer

EXPOSE 3001

# tini = proper PID-1 so SIGTERM from Fly cleanly stops the worker subprocess
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "backend/server.js"]

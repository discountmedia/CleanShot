# syntax=docker/dockerfile:1.7
# CleanShot API — Phase 2 v2.5
# Base: python:3.12-slim (Debian-based — NOT Alpine; fontconfig + librsvg work out-of-box)
# Non-root user. Multi-stage to keep final image lean.

# ─────────────────────────────────────────────────────────────────────────────
# Stage 1: builder — install deps into /install
# ─────────────────────────────────────────────────────────────────────────────
FROM python:3.12-slim AS builder

WORKDIR /build

# Install uv for fast dependency resolution
RUN pip install --no-cache-dir uv==0.4.29

COPY pyproject.toml .

# Install production deps only into a prefix directory
RUN uv pip install --system --no-cache \
    --prefix /install \
    .


# ─────────────────────────────────────────────────────────────────────────────
# Stage 2: final — minimal image with system libs and non-root user
# ─────────────────────────────────────────────────────────────────────────────
FROM python:3.12-slim AS final

# Install required system libraries for pyvips / image processing
# libvips>=8.18: pyvips bindings
# librsvg2-common: SVG rasterization
# fontconfig + fonts-liberation: required for SVG/text rendering
# fonts-roboto: Roboto for the AI-disclaimer watermark (matches web preview)
# libcairo2: pango/cairo dependency
# libwebp-dev: WebP encode/decode
# libglib2.0-0 + libgomp1: required by opencv-python-headless and onnxruntime,
#   which arrive via rembg (the background-removal matting pass). Headless
#   opencv still links glib; omitting it fails at IMPORT time, not at use, so
#   the whole API would fail to boot rather than just the cutout path.
RUN apt-get update && apt-get install -y --no-install-recommends \
        libvips42 \
        libvips-dev \
        librsvg2-common \
        fontconfig \
        fonts-liberation \
        fonts-roboto \
        libcairo2 \
        libwebp-dev \
        libglib2.0-0 \
        libgomp1 \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Copy installed Python packages from builder
COPY --from=builder /install /usr/local

# Create non-root user (least privilege — never run as root in Cloud Run)
RUN groupadd --gid 1001 appuser \
 && useradd  --uid 1001 --gid appuser --shell /bin/sh --create-home appuser

# ── Matting model, baked at BUILD time ──────────────────────────────────────
# rembg caches models under U2NET_HOME and downloads on first use. A runtime
# download is not acceptable here: the container runs as a non-root user, and a
# cold start would turn into a multi-hundred-megabyte fetch on the first
# operator request. So fetch it now, into a world-readable location.
#
# The model name MUST match CUTOUT_MODEL in services/cutout.py (default
# `isnet-general-use`). Changing that env var without changing this line means
# the first cutout request tries to download and fails.
ENV U2NET_HOME=/opt/rembg-models \
    CUTOUT_MODEL=isnet-general-use
RUN mkdir -p /opt/rembg-models \
 && python -c "from rembg import new_session; new_session('isnet-general-use')" \
 && chmod -R a+rX /opt/rembg-models

WORKDIR /app

# Copy application source
COPY src/ ./src/

# Switch to non-root
USER appuser

# Cloud Run: PORT env var is set automatically. Default 8080.
ENV PORT=8080 \
    PYTHONPATH=/app/src \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    LOG_LEVEL=INFO

EXPOSE 8080

# Single uvicorn process per Cloud Run instance.
# --workers 1: Never use gunicorn-with-uvicorn-workers on Cloud Run —
#   Cloud Run scales horizontally via instances, not vertically via workers.
# --loop uvloop + --http httptools: maximum async throughput.
# --forwarded-allow-ips=*: trust X-Forwarded-* headers from Cloud Run's proxy
#   (which hits the container from 169.254.169.126, not 127.0.0.1). Without
#   this, request.url returns http:// and OIDC audience verification fails
#   because Cloud Tasks mints the token with the https:// target URL.
CMD ["python", "-m", "uvicorn", \
     "cleanshot_api.main:app", \
     "--host", "0.0.0.0", \
     "--port", "8080", \
     "--workers", "1", \
     "--loop", "uvloop", \
     "--http", "httptools", \
     "--proxy-headers", \
     "--forwarded-allow-ips", "*", \
     "--log-level", "info"]

# CleanShot API — Cloud Run Service
# Base: python:3.12-slim (Debian) — NOT Alpine (fontconfig/librsvg issues)
FROM python:3.12-slim AS base

# System deps: libvips for pyvips, fonts for SVG rendering
RUN apt-get update && apt-get install -y --no-install-recommends \
    libvips-dev \
    libvips42 \
    librsvg2-common \
    fontconfig \
    fonts-liberation \
    libcairo2 \
    libwebp-dev \
    curl \
  && rm -rf /var/lib/apt/lists/*

# Install uv for fast Python package management
RUN curl -LsSf https://astral.sh/uv/install.sh | sh
ENV PATH="/root/.cargo/bin:$PATH"

WORKDIR /app

# Install Python dependencies
COPY pyproject.toml .
RUN uv pip install --system -e .

# Copy application code
COPY app/ ./app/

# Non-root user for security
RUN useradd --no-create-home --shell /bin/false appuser
USER appuser

# Cloud Run: single uvicorn process — never gunicorn on Cloud Run
# --workers 1 is intentional — Cloud Run handles scaling via instances
CMD ["uvicorn", "app.main:app", \
     "--host", "0.0.0.0", \
     "--port", "8080", \
     "--workers", "1", \
     "--loop", "uvloop", \
     "--http", "httptools"]

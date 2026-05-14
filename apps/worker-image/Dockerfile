# CleanShot Image Worker — Cloud Run Worker Pool
# Same base as API — requires libvips for image processing
FROM python:3.12-slim AS base

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

RUN curl -LsSf https://astral.sh/uv/install.sh | sh
ENV PATH="/root/.cargo/bin:$PATH"

WORKDIR /app
COPY pyproject.toml .
RUN uv pip install --system -e .
COPY app/ ./app/

RUN useradd --no-create-home --shell /bin/false appuser
USER appuser

# Worker Pool: no HTTP listener — pulls from Arq/Redis queue
CMD ["python", "-m", "app.worker"]

# CleanShot Video Worker — Cloud Run Worker Pool (Phase 4.5)
# Lightweight — no pyvips needed, just Veo API polling
FROM python:3.12-slim AS base

RUN apt-get update && apt-get install -y --no-install-recommends curl \
  && rm -rf /var/lib/apt/lists/*

RUN curl -LsSf https://astral.sh/uv/install.sh | sh
ENV PATH="/root/.cargo/bin:$PATH"

WORKDIR /app
COPY pyproject.toml .
RUN uv pip install --system -e .
COPY app/ ./app/

RUN useradd --no-create-home --shell /bin/false appuser
USER appuser

CMD ["python", "-m", "app.worker"]

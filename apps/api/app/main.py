# CleanShot FastAPI — main application entry point
# TODO: implement per Phase 2 Playbook v2.5
from fastapi import FastAPI

app = FastAPI(
    title="CleanShot API",
    version="0.1.0",
    docs_url=None,   # Disable in production
    redoc_url=None,
)

@app.get("/health")
async def health() -> dict:
    return {"status": "ok", "version": "0.1.0"}

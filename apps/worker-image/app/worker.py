# CleanShot Image Worker — Arq worker entry point
# TODO: implement per Phase 2 Playbook v2.5
# max_jobs=8 (I/O bound — Gemini wait time)
# job_timeout=480s (8 minutes max per image)
import asyncio

async def process_image(ctx: dict, job_id: str) -> dict:
    """Main image processing job — enhance, scan, cleanup."""
    raise NotImplementedError("TODO: implement per Phase 2 v2.5")

class WorkerSettings:
    functions = [process_image]
    max_jobs = 8
    job_timeout = 480

if __name__ == "__main__":
    from arq import run_worker
    run_worker(WorkerSettings)

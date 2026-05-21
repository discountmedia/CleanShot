from __future__ import annotations

from fastapi import APIRouter, BackgroundTasks, Depends, Request

from cleanshot_api.core.tasks_auth import require_tasks_auth
from cleanshot_api.models.schemas import (
    CleanupTaskPayload,
    EnhanceTaskPayload,
    EraseTaskPayload,
    ScanTaskPayload,
)
from cleanshot_api.workers.cleanup_worker import handle_cleanup_task
from cleanshot_api.workers.enhance_worker import (
    handle_enhance_task,
    handle_erase_task,
)
from cleanshot_api.workers.scan_worker import handle_scan_task

router = APIRouter(prefix="/worker", tags=["worker"])


@router.post(
    "/enhance",
    dependencies=[Depends(require_tasks_auth)],
)
async def worker_enhance(
    payload: EnhanceTaskPayload,
    background_tasks: BackgroundTasks,
    request: Request,
) -> dict:
    """
    Cloud Tasks target for Enhance jobs.
    OIDC-authenticated. Returns HTTP 200 immediately (quick-acknowledge).
    Gemini work runs in background via BackgroundTasks.
    """
    return await handle_enhance_task(payload, background_tasks, request)


@router.post(
    "/scan",
    dependencies=[Depends(require_tasks_auth)],
)
async def worker_scan(
    payload: ScanTaskPayload,
    background_tasks: BackgroundTasks,
    request: Request,
) -> dict:
    """
    Cloud Tasks target for Scan jobs.
    Multi-model fan-out via asyncio.TaskGroup.
    Quick-acknowledge: HTTP 200 before any AI calls.
    """
    return await handle_scan_task(payload, background_tasks, request)


@router.post(
    "/cleanup",
    dependencies=[Depends(require_tasks_auth)],
)
async def worker_cleanup(
    payload: CleanupTaskPayload,
    background_tasks: BackgroundTasks,
    request: Request,
) -> dict:
    """
    Cloud Tasks target for Cleanup jobs.
    Anomaly-guided prompt built from scan_results.
    Quick-acknowledge: HTTP 200 immediately.
    """
    return await handle_cleanup_task(payload, background_tasks, request)


@router.post(
    "/erase",
    dependencies=[Depends(require_tasks_auth)],
)
async def worker_erase(
    payload: EraseTaskPayload,
    background_tasks: BackgroundTasks,
    request: Request,
) -> dict:
    """
    Cloud Tasks target for mask-based BFL erase jobs. Source asset is a
    completed enhance variant; operator-drawn mask comes inline in the
    payload as base64 PNG. Quick-acknowledge: HTTP 200 immediately, BFL
    polling happens in background.
    """
    return await handle_erase_task(payload, background_tasks, request)

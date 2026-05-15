"""
Cloud Tasks enqueue helpers.

Two queues per Phase 2 v2.5:
  cleanshot-image-gen:  max_dispatches_per_second=0.1, max_concurrent_dispatches=10
  cleanshot-image-scan: max_dispatches_per_second=0.5, max_concurrent_dispatches=5

Retry config (both queues): max_attempts=3, min_backoff=10s, max_backoff=300s,
max_doublings=4.

Tasks use OIDC: Cloud Tasks signs each request with the tasks service account,
and the worker verifies the token (see core/tasks_auth.py).
"""

from __future__ import annotations

import json
import uuid

from google.cloud import tasks_v2
from google.protobuf import duration_pb2

from cleanshot_api.core.config import get_settings
from cleanshot_api.models.schemas import (
    CleanupTaskPayload,
    EnhanceTaskPayload,
    ScanTaskPayload,
)


def _tasks_client() -> tasks_v2.CloudTasksClient:
    return tasks_v2.CloudTasksClient()


def _make_task(
    queue_path: str,
    url: str,
    payload: dict,
    task_id: str | None = None,
) -> tasks_v2.Task:
    settings = get_settings()
    body = json.dumps(payload).encode()

    task = tasks_v2.Task(
        http_request=tasks_v2.HttpRequest(
            http_method=tasks_v2.HttpMethod.POST,
            url=url,
            headers={"Content-Type": "application/json"},
            body=body,
            oidc_token=tasks_v2.OidcToken(
                service_account_email=settings.tasks_oidc_sa,
                # Audience must be the full target URL (including path), not
                # just the base URL. Google mints the OIDC token with `aud`
                # set to whatever is provided here, and the verifier in
                # tasks_auth.py must check against the same value.
                audience=url,
            ),
        ),
        # Dispatch deadline: 30 minutes (Cloud Tasks max). Quick-acknowledge
        # pattern means the worker returns HTTP 200 immediately and does the
        # Gemini work asynchronously — this deadline is never at risk.
        dispatch_deadline=duration_pb2.Duration(seconds=1800),
    )

    if task_id:
        task.name = f"{queue_path}/tasks/{task_id}"

    return task


def enqueue_enhance(payload: EnhanceTaskPayload) -> str:
    """
    Enqueue an Enhance task. Returns the Cloud Tasks task name.
    Task ID is derived from the idempotency_key to prevent duplicates.
    """
    settings = get_settings()
    client = _tasks_client()
    queue_path = (
        f"projects/{settings.gcp_project}"
        f"/locations/{settings.tasks_location}"
        f"/queues/{settings.tasks_queue_gen}"
    )
    task_id = f"enhance-{payload.job_id}"
    task = _make_task(
        queue_path=queue_path,
        url=f"{settings.worker_url}/worker/enhance",
        payload=payload.model_dump(mode="json"),
        task_id=task_id,
    )
    response = client.create_task(parent=queue_path, task=task)
    return response.name


def enqueue_scan(payload: ScanTaskPayload) -> str:
    settings = get_settings()
    client = _tasks_client()
    queue_path = (
        f"projects/{settings.gcp_project}"
        f"/locations/{settings.tasks_location}"
        f"/queues/{settings.tasks_queue_scan}"
    )
    task_id = f"scan-{payload.job_id}"
    task = _make_task(
        queue_path=queue_path,
        url=f"{settings.worker_url}/worker/scan",
        payload=payload.model_dump(mode="json"),
        task_id=task_id,
    )
    response = client.create_task(parent=queue_path, task=task)
    return response.name


def enqueue_cleanup(payload: CleanupTaskPayload) -> str:
    settings = get_settings()
    client = _tasks_client()
    queue_path = (
        f"projects/{settings.gcp_project}"
        f"/locations/{settings.tasks_location}"
        f"/queues/{settings.tasks_queue_gen}"
    )
    task_id = f"cleanup-{payload.job_id}"
    task = _make_task(
        queue_path=queue_path,
        url=f"{settings.worker_url}/worker/cleanup",
        payload=payload.model_dump(mode="json"),
        task_id=task_id,
    )
    response = client.create_task(parent=queue_path, task=task)
    return response.name

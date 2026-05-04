"""
Sessions API — creates and refreshes user sessions.
"""

from fastapi import APIRouter, Request
from pydantic import BaseModel

router = APIRouter(tags=["sessions"])


class SessionResponse(BaseModel):
    session_id: str


@router.post("/sessions", response_model=SessionResponse)
async def create_session(request: Request) -> SessionResponse:
    """Create a new session."""
    session_svc = request.app.state.session_service
    session_id = await session_svc.create_session()
    return SessionResponse(session_id=session_id)

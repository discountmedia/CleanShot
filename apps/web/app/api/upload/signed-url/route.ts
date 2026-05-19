// apps/web/app/api/upload/signed-url/route.ts
// BFF Route Handler — POST /api/upload/signed-url
//
// Mints a V4 signed PUT URL for direct browser-to-GCS upload by proxying to
// FastAPI's POST /api/v1/upload/signed-url. The API pod never receives bytes;
// only the upload URL + asset row are pre-allocated server-side.
//
// FastAPI's SignedUploadUrlRequest is snake_case (no Pydantic aliases on
// this schema), so we translate keys at this boundary:
//   incoming  { sessionId,  filename, contentType }   from getSignedUploadUrl()
//   outgoing  { session_id, filename, content_type }  to FastAPI
//   response  { upload_url, asset_id, gcs_uri }       from FastAPI
//   outgoing  { uploadUrl,  assetId,  gcsUri  }       to caller

import { type NextRequest, NextResponse } from "next/server";

export const maxDuration = 15;
export const dynamic = "force-dynamic";

interface ClientRequest {
  sessionId: string;
  filename: string;
  contentType: string;
}

interface FastApiResponse {
  upload_url: string;
  asset_id: string;
  gcs_uri: string;
}

export async function POST(request: NextRequest) {
  const base = process.env.FASTAPI_INTERNAL_URL;
  const key  = process.env.FASTAPI_INTERNAL_KEY;
  if (!base || !key) {
    return NextResponse.json(
      { detail: "FASTAPI_INTERNAL_URL / FASTAPI_INTERNAL_KEY env vars are not set" },
      { status: 500 }
    );
  }

  const body = (await request.json()) as ClientRequest;

  const res = await fetch(`${base}/api/v1/upload/signed-url`, {
    method: "POST",
    headers: {
      "X-Api-Key":   key,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      session_id:   body.sessionId,
      filename:     body.filename,
      content_type: body.contentType,
    }),
    signal: request.signal,
    cache: "no-store",
  });

  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    return NextResponse.json({ detail: text }, { status: res.status });
  }

  const data = (await res.json()) as FastApiResponse;
  return NextResponse.json({
    uploadUrl: data.upload_url,
    assetId:   data.asset_id,
    gcsUri:    data.gcs_uri,
  });
}

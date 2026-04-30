"""
End-to-end smoke test for CleanShot v1 (Enhance tab only).

Run AFTER `docker compose up` is healthy AND you have a forklift photo
on disk to test with. Usage:

    python smoke_test.py path/to/forklift.jpg

Walks the full flow:
  1. POST /sessions
  2. POST /assets/upload-url
  3. PUT bytes directly to GCS via signed URL
  4. POST /enhance
  5. Poll GET /jobs/{id} until status in {done, failed}
  6. Print download URL on success

Requires: requests
    pip install requests
"""

import sys
import time
import requests

API = "http://localhost:8000/api/v1"


def main(image_path: str) -> int:
    print(f"== Smoke test against {API}")

    # --- 1. Session
    r = requests.post(f"{API}/sessions")
    r.raise_for_status()
    session_id = r.json()["session_id"]
    print(f"[1] session_id = {session_id}")

    # --- 2. Upload URL
    mime = "image/jpeg" if image_path.lower().endswith((".jpg", ".jpeg")) else "image/png"
    r = requests.post(
        f"{API}/assets/upload-url",
        json={"session_id": session_id, "mime_type": mime},
    )
    r.raise_for_status()
    payload = r.json()
    asset_id = payload["asset_id"]
    put_url = payload["signed_put_url"]
    print(f"[2] asset_id = {asset_id}")

    # --- 3. PUT bytes directly to GCS
    with open(image_path, "rb") as f:
        upload = requests.put(put_url, data=f, headers={"Content-Type": mime})
    if upload.status_code not in (200, 201):
        print(f"  GCS upload failed: {upload.status_code} {upload.text[:200]}")
        return 1
    print(f"[3] uploaded {image_path} to GCS")

    # --- 4. Enqueue enhance
    r = requests.post(
        f"{API}/enhance",
        json={
            "session_id": session_id,
            "asset_id": asset_id,
            "enhancement_level": "moderate",
        },
    )
    r.raise_for_status()
    job_id = r.json()["job_id"]
    print(f"[4] job_id = {job_id}")

    # --- 5. Poll
    print("[5] polling /jobs ...")
    start = time.time()
    while True:
        time.sleep(2)
        r = requests.get(f"{API}/jobs/{job_id}")
        r.raise_for_status()
        job = r.json()
        elapsed = int(time.time() - start)
        print(f"    [{elapsed:>3}s] status={job['status']:<8} progress={job['progress']:>3}  {job.get('message','')}")
        if job["status"] in ("done", "failed"):
            break
        if elapsed > 300:
            print("    !! timeout after 5 minutes")
            return 2

    if job["status"] == "failed":
        print(f"\n[!] Job failed: {job.get('message')}")
        return 3

    # --- 6. Done
    print(f"\n[6] DONE in {int(time.time()-start)}s")
    print(f"    result_uri:   {job.get('result_uri')}")
    print(f"    download_url: {job.get('download_url')}")
    print("\nOpen the download_url in a browser to view the enhanced image.")
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(__doc__)
        sys.exit(64)
    sys.exit(main(sys.argv[1]))

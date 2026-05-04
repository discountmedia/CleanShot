End-to-end smoke test for CleanShot v1 — supports both enhance and scan.

Usage:
    # Enhance a forklift photo (default operation):
    python smoke_test.py path/to/forklift.jpg [api_base_url]

    # Run multi-provider scan on an image:
    python smoke_test.py path/to/image.jpg [api_base_url] --scan

If api_base_url is omitted, defaults to http://localhost:8000/api/v1.
For production:
    https://forklift-api-l4xpvatepq-uc.a.run.app/api/v1

Walks the full flow:
  1. POST /sessions
  2. POST /assets/upload-url
  3. PUT bytes directly to GCS via signed URL
  4. POST /enhance OR /scan
  5. Poll GET /jobs/{id} until status in {done, failed}
  6. Print result on success

Requires: requests
    pip install requests
"""
import sys
import time
import json
import requests


def run_test(image_path: str, api_base: str, operation: str) -> int:
    print(f"== Smoke test ({operation}) against {api_base}")

    # --- 1. Session
    r = requests.post(f"{api_base}/sessions")
    r.raise_for_status()
    session_id = r.json()["session_id"]
    print(f"[1] session_id = {session_id}")

    # --- 2. Upload URL
    mime = "image/jpeg" if image_path.lower().endswith((".jpg", ".jpeg")) else "image/png"
    r = requests.post(
        f"{api_base}/assets/upload-url",
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

    # --- 4. Submit job (enhance or scan)
    if operation == "scan":
        r = requests.post(
            f"{api_base}/scan",
            json={"session_id": session_id, "asset_id": asset_id},
        )
    else:
        r = requests.post(
            f"{api_base}/enhance",
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
        r = requests.get(f"{api_base}/jobs/{job_id}")
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
    if operation == "scan":
        scan_result = job.get("scan_result")
        if isinstance(scan_result, str):
            scan_result = json.loads(scan_result)
        print(f"    verdict:    {scan_result.get('verdict')}")
        print(f"    confidence: {scan_result.get('confidence')}")
        print(f"    agreement:  {scan_result.get('agreement')}")
        print(f"    source:     {scan_result.get('source')}")
        print(f"    summary:    {scan_result.get('summary')}")
        if scan_result.get('issues'):
            print(f"    issues:")
            for issue in scan_result['issues']:
                print(f"      - {issue}")
        if scan_result.get('warnings'):
            print(f"    warnings:")
            for w in scan_result['warnings']:
                print(f"      - {w}")
    else:
        print(f"    result_uri:   {job.get('result_uri')}")
        print(f"    download_url: {job.get('download_url')}")
        print("\nOpen the download_url in a browser to view the enhanced image.")
    return 0


if __name__ == "__main__":
    args = sys.argv[1:]
    operation = "enhance"
    if "--scan" in args:
        operation = "scan"
        args.remove("--scan")

    if len(args) < 1 or len(args) > 2:
        print(__doc__)
        sys.exit(64)

    image_path = args[0]
    api_base = args[1] if len(args) == 2 else "http://localhost:8000/api/v1"
    sys.exit(run_test(image_path, api_base, operation))

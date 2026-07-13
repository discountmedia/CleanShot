#!/usr/bin/env python3
"""
Rebuild an A/B report with images EMBEDDED as base64 data URIs — fully
self-contained, no signed URLs (so no expiry, no &amp; query-string issues,
opens in any viewer offline). Reads a run's results.json (operator-judged A/B
shape) and writes report_embedded.html next to it.

Usage: python scripts/make_embedded_report.py <run_dir>
"""
from __future__ import annotations

import base64
import concurrent.futures as cf
import html
import json
import os
import subprocess
import sys
import urllib.request

GCLOUD = r"C:\Program Files (x86)\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd"
PROJECT = "cleanshot-493512"
API_BASE = "https://cleanshot-api-387208973244.us-central1.run.app"


def gc_text(args):
    r = subprocess.run(["cmd", "/c", GCLOUD, *args], capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(r.stderr.strip()[:200])
    return r.stdout


def data_uri(asset_id, key):
    if not asset_id:
        return None
    try:
        req = urllib.request.Request(f"{API_BASE}/api/v1/assets/{asset_id}/url",
                                     headers={"X-Api-Key": key})
        url = json.loads(urllib.request.urlopen(req, timeout=60).read())["url"]
        img = urllib.request.urlopen(url, timeout=120).read()
        mt = "image/png" if img[:8] == b"\x89PNG\r\n\x1a\n" else "image/jpeg"
        return f"data:{mt};base64,{base64.b64encode(img).decode()}"
    except Exception:  # noqa: BLE001
        return None


def main():
    run_dir = sys.argv[1]
    d = json.load(open(os.path.join(run_dir, "results.json"), encoding="utf-8"))
    results = d["results"]
    key = gc_text(["secrets", "versions", "access", "latest",
                   "--secret=cleanshot-api-key", f"--project={PROJECT}"]).strip()

    # Collect all asset ids, fetch+embed in parallel.
    ids = set()
    for r in results:
        ids.add(r.get("orig_asset"))
        for arm in ("baseline", "candidate"):
            ids.add((r.get(arm) or {}).get("enh_asset"))
    ids.discard(None)
    print(f"[report] embedding {len(ids)} images …", flush=True)
    uris = {}
    with cf.ThreadPoolExecutor(max_workers=8) as ex:
        futs = {ex.submit(data_uri, i, key): i for i in ids}
        for fut in cf.as_completed(futs):
            uris[futs[fut]] = fut.result()

    def cell(arm):
        if not arm:
            return "(none)"
        u = uris.get(arm.get("enh_asset"))
        img = f'<img src="{u}">' if u else f"({html.escape(arm.get('status', '?'))})"
        v = arm.get("verdict") or arm.get("status")
        vc = {"pass": "ok", "fail": "bad"}.get(v, "warn")
        return f'{img}<div class="v {vc}">{html.escape(str(v)).upper()}</div><div class=dim>{html.escape(arm.get("reason") or "")}</div>'

    def bad_base(r):
        return (r.get("baseline") or {}).get("verdict") != "fail"

    rows = []
    for r in sorted(results, key=lambda x: (bad_base(x), x["equipment_type"])):
        ou = uris.get(r.get("orig_asset"))
        o = f'<img src="{ou}">' if ou else "(no orig)"
        rows.append(f"""<tr>
          <td><b>{html.escape(r['make'])} {html.escape(r['model'])}</b>
              <div class=dim>{html.escape(r['equipment_type'])}</div></td>
          <td>{o}</td><td>{cell(r.get('baseline'))}</td><td>{cell(r.get('candidate'))}</td>
        </tr>""")
    css = """body{font:14px system-ui;background:#0b0b0e;color:#e5e5e5;margin:24px}
    table{border-collapse:collapse;width:100%}td,th{border:1px solid #2a2a30;padding:8px;
    vertical-align:top;text-align:left}img{width:320px;border-radius:6px;display:block}
    .dim{color:#8a8a92;font-size:12px}.v{font-weight:700;margin:4px 0}.v.ok{color:#4ade80}
    .v.bad{color:#f87171}.v.warn{color:#fbbf24}"""
    body = (f"<h1>Enhance A/B — per-type block OFF vs ON (isolation)</h1>"
            f"<p class=dim>Only variable is the 'THIS MACHINE' block. Verdicts are the "
            f"triage judge (~70%); your eye is final. Sorted block-OFF-fails first.</p>"
            f"<table><thead><tr><th>Unit</th><th>Original</th>"
            f"<th>Block OFF</th><th>Block ON</th></tr></thead>"
            f"<tbody>{''.join(rows)}</tbody></table>")
    out = os.path.join(run_dir, "report_embedded.html")
    with open(out, "w", encoding="utf-8") as fh:
        fh.write(f"<!doctype html><meta charset=utf-8><style>{css}</style>{body}")
    print(f"[report] wrote {out}  ({os.path.getsize(out)//1024//1024} MB)")


if __name__ == "__main__":
    main()

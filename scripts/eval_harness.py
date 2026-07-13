#!/usr/bin/env python3
"""
CleanShot enhance eval harness — operator-judged A/B.

For each fixture (optionally filtered to specific equipment types), runs the same
original through TWO prompts:
  • baseline  — current server prompt (no custom_prompt)
  • candidate — scripts/candidate_prompt.build_candidate(...) via custom_prompt (no deploy)
then scores each output with the holistic "would you list this?" judge (Claude), and
builds a before/after HTML report with FRESH signed links so the OPERATOR makes the
final call. The judge is a directional triage number (~70% agreement with the
operator); the operator's eye on the report is the ground truth.

Fixtures: captioned catalogue corpus gs://cleanshot-training-df-2026. Pure stdlib +
gcloud. Reads API key + Anthropic key from Secret Manager.

Usage:
  python scripts/eval_harness.py --dry-run --types reach_truck,order_picker,walkie_stacker,pallet_jack --n 12
  python scripts/eval_harness.py --types reach_truck,order_picker,walkie_stacker,pallet_jack --n 12
"""

from __future__ import annotations

import argparse
import concurrent.futures as cf
import html
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import urllib.request
import uuid
from collections import Counter, defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from candidate_prompt import EQUIP_ANATOMY, EQUIP_DISPLAY, build_candidate  # noqa: E402
from holistic_judge import judge as holistic_judge, url_to_gs  # noqa: E402

GCLOUD = r"C:\Program Files (x86)\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd"
PROJECT = "cleanshot-493512"
API_BASE = "https://cleanshot-api-387208973244.us-central1.run.app"
CORPUS_BUCKET = "gs://cleanshot-training-df-2026"
MANIFEST_URIS = [f"{CORPUS_BUCKET}/manifests/validation.jsonl",
                 f"{CORPUS_BUCKET}/manifests/training.jsonl"]
BASELINE_TOGGLES = {"paintForksRedYellowTips": True, "removeRentalBranding": True,
                    "improveLighting": True}

EQUIP_KEYWORDS = [
    ("scissor lift", "scissor_lift"), ("telehandler", "telehandler"),
    ("telescopic handler", "telehandler"), ("order picker", "order_picker"),
    ("reach truck", "reach_truck"), ("turret", "turret_truck"),
    ("swing reach", "turret_truck"), ("very narrow aisle", "turret_truck"),
    ("articulat", "articulated_forklift"), ("pallet jack", "pallet_jack"),
    ("pallet truck", "pallet_jack"), ("walkie", "walkie_stacker"),
    ("walk-behind", "walkie_stacker"), ("straddle stacker", "walkie_stacker"),
    ("forklift", "forklift"), ("lift truck", "forklift"),
]
MAKE_HINTS = {"bendi": "articulated_forklift", "flexi": "articulated_forklift",
              "aisle-master": "articulated_forklift"}


def gc_text(args):
    r = subprocess.run(["cmd", "/c", GCLOUD, *args], capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(f"gcloud {' '.join(args)}: {r.stderr.strip()[:300]}")
    return r.stdout


def api(method, path, key, body=None, timeout=60.0):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(f"{API_BASE}{path}", data=data, method=method,
                                 headers={"X-Api-Key": key, "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read()
    return json.loads(raw) if raw else {}


def gcs_put(url, image_bytes, content_type, timeout=120.0):
    req = urllib.request.Request(url, data=image_bytes, method="PUT",
                                 headers={"Content-Type": content_type})
    urllib.request.urlopen(req, timeout=timeout).read()


def poll_job(job_id, key, max_wait, interval=4.0):
    deadline = time.monotonic() + max_wait
    while time.monotonic() < deadline:
        j = api("GET", f"/api/v1/jobs/{job_id}", key)
        if j.get("status") in ("complete", "failed", "cancelled"):
            return j
        time.sleep(interval)
    return {"status": "timeout"}


def parse_record(rec):
    uri = (rec.get("image") or {}).get("gcsUri") or rec.get("gcsUri")
    caption = rec.get("caption", "") or ""
    if not uri or "/images/" not in uri:
        return None
    parts = uri.split("/images/", 1)[1].split("/")
    make = parts[0] if parts else ""
    model = parts[1] if len(parts) > 2 else ""
    cap_l = caption.lower()
    equip = next((et for kw, et in EQUIP_KEYWORDS if kw in cap_l), None)
    if equip in (None, "forklift") and make in MAKE_HINTS:
        equip = MAKE_HINTS[make]
    equip = equip or "forklift"
    ym = re.search(r"\b(19|20)\d{2}\b", caption)
    cm = re.search(r"([\d,]{3,7})\s*lb", caption, re.I)
    return {"uri": uri, "make": make.replace("_", " ").replace("-", " ").title(), "make_raw": make,
            "model": model.replace("_", " ").upper() if model else "", "equipment_type": equip,
            "year": ym.group(0) if ym else None,
            "capacity": (cm.group(1).replace(",", "") + " lbs") if cm else None}


def load_manifest():
    last = None
    for muri in MANIFEST_URIS:
        try:
            txt = gc_text(["storage", "cat", muri])
        except Exception as e:  # noqa: BLE001
            last = e
            continue
        recs = []
        for line in txt.splitlines():
            line = line.strip()
            if line:
                try:
                    p = parse_record(json.loads(line))
                except json.JSONDecodeError:
                    p = None
                if p:
                    recs.append(p)
        if recs:
            return muri, recs
    raise RuntimeError(f"no usable manifest ({last})")


def stratified_sample(recs, n, types=None, seed=42):
    import random
    rng = random.Random(seed)
    if types:
        recs = [r for r in recs if r["equipment_type"] in types]
    by_type = defaultdict(list)
    for r in recs:
        by_type[r["equipment_type"]].append(r)
    ordered = {}
    for et, items in by_type.items():
        rng.shuffle(items)
        seen, first, rest = set(), [], []
        for it in items:
            (first if it["make_raw"] not in seen else rest).append(it)
            seen.add(it["make_raw"])
        ordered[et] = first + rest
    keys = sorted(ordered)
    picked, idx = [], {et: 0 for et in keys}
    while len(picked) < n and any(idx[et] < len(ordered[et]) for et in keys):
        for et in keys:
            if idx[et] < len(ordered[et]):
                picked.append(ordered[et][idx[et]]); idx[et] += 1
                if len(picked) >= n:
                    break
    return picked


def run_arm(rec, session_id, orig_asset, orig_gs, provider, key, akey, variant, tmp):
    arm = {"variant": variant, "status": "pending", "verdict": None, "reason": None,
           "enh_asset": None, "enhance_ms": None, "error": None}
    try:
        equip = rec["equipment_type"]
        disp = EQUIP_DISPLAY.get(equip, "forklift")
        # Isolation A/B: BOTH arms use the candidate builder; the ONLY difference is
        # the per-type "THIS MACHINE" block (variant "candidate" = block ON,
        # "baseline" = block OFF). Everything else in the prompt is identical.
        body = {"session_id": session_id, "asset_id": orig_asset, "toggles": BASELINE_TOGGLES,
                "provider": provider, "equipment_type": equip,
                "idempotency_key": f"eval-{variant}-{uuid.uuid4().hex}",
                "custom_prompt": build_candidate(
                    BASELINE_TOGGLES, disp, EQUIP_ANATOMY.get(equip, ""),
                    rec["make"], rec["model"], rec["year"],
                    include_this_machine=(variant == "candidate"))}
        t0 = time.monotonic()
        en = api("POST", "/api/v1/enhance", key, body)
        job = poll_job(en["job_id"], key, max_wait=150)
        arm["enhance_ms"] = int((time.monotonic() - t0) * 1000)
        if job.get("status") != "complete":
            arm["status"] = "enhance_failed"; arm["error"] = job.get("error") or job.get("status")
            return arm
        enh = job["output_asset_id"]
        arm["enh_asset"] = enh
        enh_gs = url_to_gs(api("GET", f"/api/v1/assets/{enh}/url", key)["url"])
        v, reason = holistic_judge(orig_gs, enh_gs, akey, tmp)
        arm["verdict"], arm["reason"], arm["status"] = v, reason, "ok"
    except Exception as e:  # noqa: BLE001
        arm["status"] = "error"; arm["error"] = str(e)[:300]
    return arm


def run_fixture(rec, session_id, provider, key, akey, tmp):
    out = {**rec, "orig_asset": None, "baseline": None, "candidate": None, "error": None}
    try:
        local = os.path.join(tmp, f"{uuid.uuid4().hex}.jpg")
        subprocess.run(["cmd", "/c", GCLOUD, "storage", "cp", rec["uri"], local, f"--project={PROJECT}"],
                       capture_output=True, text=True, check=True)
        with open(local, "rb") as fh:
            img = fh.read()
        os.remove(local)
        su = api("POST", "/api/v1/upload/signed-url", key,
                 {"filename": "eval.jpg", "content_type": "image/jpeg", "session_id": session_id})
        out["orig_asset"] = su["asset_id"]
        gcs_put(su["upload_url"], img, "image/jpeg")
        out["baseline"] = run_arm(rec, session_id, su["asset_id"], su["gcs_uri"], provider, key, akey, "baseline", tmp)
        out["candidate"] = run_arm(rec, session_id, su["asset_id"], su["gcs_uri"], provider, key, akey, "candidate", tmp)
    except Exception as e:  # noqa: BLE001
        out["error"] = str(e)[:300]
    return out


def _url(asset_id, key):
    if not asset_id:
        return None
    try:
        return api("GET", f"/api/v1/assets/{asset_id}/url", key).get("url")
    except Exception:  # noqa: BLE001
        return None


def _cell(arm, key):
    if not arm:
        return "(none)"
    u = _url(arm.get("enh_asset"), key)
    img = f'<img src="{html.escape(u)}">' if u else f"({html.escape(arm.get('status', '?'))})"
    v = arm.get("verdict") or arm.get("status")
    vc = {"pass": "ok", "fail": "bad"}.get(v, "warn")
    return f'{img}<div class="v {vc}">{html.escape(str(v)).upper()}</div><div class=dim>{html.escape(arm.get("reason") or "")}</div>'


def write_report(results, out_dir, key, meta):
    def bad_base(r):
        return (r.get("baseline") or {}).get("verdict") != "fail"
    rows = []
    for r in sorted(results, key=lambda x: (bad_base(x), x["equipment_type"])):
        ou = _url(r.get("orig_asset"), key)
        o = f'<img src="{html.escape(ou)}">' if ou else "(no orig)"
        rows.append(f"""<tr>
          <td><b>{html.escape(r['make'])} {html.escape(r['model'])}</b>
              <div class=dim>{html.escape(r['equipment_type'])}</div></td>
          <td>{o}</td><td>{_cell(r.get('baseline'), key)}</td><td>{_cell(r.get('candidate'), key)}</td>
        </tr>""")
    css = """body{font:14px system-ui;background:#0b0b0e;color:#e5e5e5;margin:24px}
    table{border-collapse:collapse;width:100%}td,th{border:1px solid #2a2a30;padding:8px;
    vertical-align:top;text-align:left}img{width:300px;border-radius:6px;display:block}
    .dim{color:#8a8a92;font-size:12px}.v{font-weight:700;margin:4px 0}.v.ok{color:#4ade80}
    .v.bad{color:#f87171}.v.warn{color:#fbbf24}"""
    body = (f"<h1>Enhance A/B — per-type block OFF vs ON (isolation)</h1>"
            f"<p class=dim>{html.escape(json.dumps(meta))} — only variable is the 'THIS "
            f"MACHINE' block. Verdicts are the triage judge; your eye is final.</p>"
            f"<table><thead><tr><th>Unit</th><th>Original</th>"
            f"<th>Block OFF</th><th>Block ON</th></tr></thead>"
            f"<tbody>{''.join(rows)}</tbody></table>")
    path = os.path.join(out_dir, "report.html")
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(f"<!doctype html><meta charset=utf-8><style>{css}</style>{body}")
    return path


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=12)
    ap.add_argument("--provider", default="gemini")
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--types", default=None, help="comma-separated equipment types to restrict to")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--out", default=os.path.join(os.getcwd(), "eval_runs"))
    args = ap.parse_args()
    types = set(args.types.split(",")) if args.types else None

    print("[eval] loading manifest …", flush=True)
    muri, recs = load_manifest()
    sample = stratified_sample(recs, args.n, types)
    print(f"[eval] manifest={muri.split('/')[-1]} sampled={len(sample)} "
          f"types={dict(Counter(r['equipment_type'] for r in sample))}")
    if args.dry_run:
        for i, r in enumerate(sample, 1):
            print(f"  {i:2}. {r['equipment_type']:18} {r['make']:14} {r['model']:12} {r.get('year') or '?'}")
        return

    os.makedirs(args.out, exist_ok=True)
    key = gc_text(["secrets", "versions", "access", "latest",
                   "--secret=cleanshot-api-key", f"--project={PROJECT}"]).strip()
    akey = gc_text(["secrets", "versions", "access", "latest",
                    "--secret=cleanshot-anthropic-key", f"--project={PROJECT}"]).strip()
    session_id = api("POST", "/api/v1/sessions", key)["session_id"]
    print(f"[eval] A/B session={session_id} provider={args.provider}", flush=True)

    results = []
    with tempfile.TemporaryDirectory() as tmp, cf.ThreadPoolExecutor(max_workers=args.workers) as ex:
        futs = {ex.submit(run_fixture, r, session_id, args.provider, key, akey, tmp): r for r in sample}
        for i, fut in enumerate(cf.as_completed(futs), 1):
            r = fut.result(); results.append(r)
            bv = (r.get("baseline") or {}).get("verdict")
            cv = (r.get("candidate") or {}).get("verdict")
            print(f"[eval] {i}/{len(sample)} {r['equipment_type']:16} {r['make']} {r['model']:10} "
                  f"baseline={bv} candidate={cv}", flush=True)

    scored = [r for r in results if (r.get("baseline") or {}).get("verdict") in ("pass", "fail")
              and (r.get("candidate") or {}).get("verdict") in ("pass", "fail")]
    n = len(scored)
    bpass = sum(r["baseline"]["verdict"] == "pass" for r in scored)
    cpass = sum(r["candidate"]["verdict"] == "pass" for r in scored)
    fixed = sum(1 for r in scored if r["baseline"]["verdict"] == "fail" and r["candidate"]["verdict"] == "pass")
    regr = sum(1 for r in scored if r["baseline"]["verdict"] == "pass" and r["candidate"]["verdict"] == "fail")
    meta = {"provider": args.provider, "scored": n, "types": args.types}
    json.dump({"meta": meta, "results": results}, open(os.path.join(args.out, "results.json"), "w", encoding="utf-8"), indent=2)
    report = write_report(results, args.out, key, meta)

    print("\n" + "=" * 62)
    print(f"[eval] JUDGE A/B on {n} (triage judge; your eye is final)")
    print(f"[eval]   baseline  PASS = {bpass}/{n}" + (f" = {bpass/n*100:.0f}%" if n else ""))
    print(f"[eval]   candidate PASS = {cpass}/{n}" + (f" = {cpass/n*100:.0f}%" if n else ""))
    print(f"[eval]   candidate FIXED (baseline fail -> candidate pass): {fixed}")
    print(f"[eval]   candidate REGRESSED (baseline pass -> candidate fail): {regr}")
    print(f"[eval]   session={session_id}")
    print(f"[eval]   report: {report}")
    print("=" * 62)


if __name__ == "__main__":
    main()

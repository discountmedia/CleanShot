#!/usr/bin/env python3
"""
Holistic "would you list this?" judge — calibration against operator labels.

The differential scan's part-diff anomaly count does NOT predict the operator's
pass/fail (a passed image can have more flagged changes than a failed one). The
operator judges holistically: "is this a believable, acceptable listing photo of
THIS machine?" This script builds that judge (Claude vision + an operator-derived
rubric) and measures how well it reproduces the operator's hand labels, so we get
a scoreboard that actually correlates with what they'd ship.

It recovers the EXACT enhanced images the operator labeled from the baseline eval
run (parsing the saved signed URLs back to gs:// objects, then downloading with
our own gcloud auth — the signatures are expired but the object paths are valid).

Pure stdlib + gcloud. Reads Anthropic key from Secret Manager.
"""

from __future__ import annotations

import base64
import concurrent.futures as cf
import json
import os
import subprocess
import sys
import tempfile
import urllib.request
import uuid
from collections import Counter
from urllib.parse import urlparse

GCLOUD = r"C:\Program Files (x86)\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd"
PROJECT = "cleanshot-493512"
ANTHROPIC_KEY_SECRET = "cleanshot-anthropic-key"
JUDGE_MODEL = "claude-sonnet-4-6"
BASELINE_RESULTS = ("C:/Users/skc/AppData/Local/Temp/claude/c--dev-CleanShot/"
                    "2c1e24d7-db4f-45ae-9e73-07e7150f9f44/scratchpad/eval_baseline/results.json")

# Operator ground truth (substrings matched against "make model").
PASS_KEYS = ["b35", "crayler", "44s", "532 loadall", "944e", "th528"]
FAIL_KEYS = ["400s", "erp035", "fg18", "nro040", "easi-ocp", "r30f", "ops15",
             "b60zhd", "ep30a", "nrr35", "6fbpu15", "260mrt", "6bwc10", "mbc20"]

RUBRIC = """You are the final quality-control reviewer for a USED-forklift dealer's
online listing photos. You are shown TWO images of the SAME machine:
  IMAGE 1 = the ORIGINAL real photo.
  IMAGE 2 = an AI-ENHANCED version intended to go on the sales listing.

Decide: would the dealer list IMAGE 2? Answer "pass" or "fail".

The enhancer is ONLY allowed to: lightly respray the BODY in its OWN existing colour,
paint the FORKS red with yellow tips, keep the load-backrest black, clean/soften the
background and floor, and improve lighting. Nothing else about the machine may change.

FAIL if IMAGE 2 shows ANY of these vs IMAGE 1 — these are the exact defects the dealer
rejects:
- COMPONENT RECOLOURED to a CLEARLY DIFFERENT HUE: a part changed to a different colour
  family than the original — especially the CAB / operator compartment, the MAST, the
  body, or a panel (e.g. yellow→red, grey→blue, orange→charcoal). This is a real defect.
  NOT a defect: a cleaner/brighter version of the SAME colour, or darkening a frame /
  fork-carriage / load-backrest / overhead-guard toward BLACK (that black treatment is
  intended). Only flag a genuine hue SWAP, not darkening or same-colour freshening.
- DESATURATED / WASHED-OUT: components look greyed, faded, or less saturated than the
  original.
- WHEELS OR PARTS ADDED/REMOVED: a wheel, axle, or part appears that was not in the
  original (or a real part is gone), changing the machine's configuration.
- RESHAPED: the machine's overall shape, structure, or silhouette has been redrawn so it
  no longer matches the real unit's proportions (a "completely different look").
- OBVIOUSLY AI-GENERATED: melted, warped, plasticky, smeared, or nonsensical structure.
- MODEL TEXT WRONG: a legible model-number or capacity plate is SIGNIFICANTLY wrong (a
  1-2 character difference on a small marking is fine).

PASS only if NONE of the above apply — IMAGE 2 still looks like the same real unit,
changed only in the allowed ways. Tolerate: same-colour body respray, red/yellow forks,
black load-backrest, cleaned background/floor, better lighting, subtle harmless
differences, tiny text differences, and filling in parts that were merely hard to see.

Respond with ONLY a JSON object: {"verdict":"pass"|"fail","reason":"<one sentence>"}."""


def gc_text(args):
    r = subprocess.run(["cmd", "/c", GCLOUD, *args], capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(f"gcloud {' '.join(args)}: {r.stderr.strip()[:200]}")
    return r.stdout


def url_to_gs(url):
    p = urlparse(url)
    host, path = p.netloc, p.path.lstrip("/")
    if host and host != "storage.googleapis.com" and host.endswith("storage.googleapis.com"):
        return f"gs://{host.split('.')[0]}/{path}"          # virtual-hosted
    bucket, _, obj = path.partition("/")                     # path-style
    return f"gs://{bucket}/{obj}"


def download(uri, dest):
    subprocess.run(["cmd", "/c", GCLOUD, "storage", "cp", uri, dest, f"--project={PROJECT}"],
                   capture_output=True, text=True, check=True)


def b64_media(path):
    with open(path, "rb") as fh:
        data = fh.read()
    mt = "image/png" if data[:8] == b"\x89PNG\r\n\x1a\n" else "image/jpeg"
    return base64.b64encode(data).decode(), mt


def judge(orig_gs, enh_gs, akey, tmp):
    of = os.path.join(tmp, f"{uuid.uuid4().hex}.img")
    ef = os.path.join(tmp, f"{uuid.uuid4().hex}.img")
    download(orig_gs, of)
    download(enh_gs, ef)
    ob, om = b64_media(of)
    eb, em = b64_media(ef)
    os.remove(of); os.remove(ef)
    body = {
        "model": JUDGE_MODEL, "max_tokens": 300, "system": RUBRIC,
        "messages": [{"role": "user", "content": [
            {"type": "text", "text": "IMAGE 1 — ORIGINAL real photo:"},
            {"type": "image", "source": {"type": "base64", "media_type": om, "data": ob}},
            {"type": "text", "text": "IMAGE 2 — AI-ENHANCED version for the listing:"},
            {"type": "image", "source": {"type": "base64", "media_type": em, "data": eb}},
            {"type": "text", "text": "Would the dealer list IMAGE 2? Respond with the JSON only."},
        ]}],
    }
    req = urllib.request.Request(
        "https://api.anthropic.com/v1/messages", data=json.dumps(body).encode(), method="POST",
        headers={"x-api-key": akey, "anthropic-version": "2023-06-01", "content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=120) as resp:
        out = json.loads(resp.read())
    txt = "".join(b.get("text", "") for b in out.get("content", []) if b.get("type") == "text")
    s, e = txt.find("{"), txt.rfind("}")
    parsed = json.loads(txt[s:e + 1]) if s >= 0 else {"verdict": "?", "reason": txt[:120]}
    return parsed.get("verdict", "?"), parsed.get("reason", "")


def main():
    d = json.load(open(BASELINE_RESULTS, encoding="utf-8"))
    labeled = []
    for r in d["results"]:
        key = f"{r.get('make','')} {r.get('model','')}".lower()
        label = ("pass" if any(k in key for k in PASS_KEYS)
                 else "fail" if any(k in key for k in FAIL_KEYS) else None)
        if label and r.get("orig_url") and r.get("enh_url"):
            labeled.append({"key": key.strip(), "label": label,
                            "orig": url_to_gs(r["orig_url"]), "enh": url_to_gs(r["enh_url"])})
    print(f"[judge] matched {len(labeled)} labeled image-pairs "
          f"({sum(x['label']=='pass' for x in labeled)} pass / "
          f"{sum(x['label']=='fail' for x in labeled)} fail)")

    akey = gc_text(["secrets", "versions", "access", "latest",
                    f"--secret={ANTHROPIC_KEY_SECRET}", f"--project={PROJECT}"]).strip()

    rows = []
    with tempfile.TemporaryDirectory() as tmp, cf.ThreadPoolExecutor(max_workers=5) as ex:
        futs = {ex.submit(judge, x["orig"], x["enh"], akey, tmp): x for x in labeled}
        for fut in cf.as_completed(futs):
            x = futs[fut]
            try:
                v, reason = fut.result()
            except Exception as e:  # noqa: BLE001
                v, reason = "error", str(e)[:120]
            agree = "OK " if v == x["label"] else "XX "
            rows.append({**x, "judge": v, "reason": reason, "agree": v == x["label"]})
            print(f"  {agree} {x['key']:28} operator={x['label']:4} judge={v:5} — {reason[:90]}")

    ok = [r for r in rows if r["judge"] in ("pass", "fail")]
    agree = sum(r["agree"] for r in ok)
    pass_rows = [r for r in ok if r["label"] == "pass"]
    fail_rows = [r for r in ok if r["label"] == "fail"]
    pass_rec = sum(r["judge"] == "pass" for r in pass_rows)
    fail_rec = sum(r["judge"] == "fail" for r in fail_rows)
    print("\n" + "=" * 60)
    print(f"[judge] model={JUDGE_MODEL}   agreement = {agree}/{len(ok)} = {agree/len(ok)*100:.0f}%")
    print(f"[judge]   operator PASS reproduced: {pass_rec}/{len(pass_rows)}")
    print(f"[judge]   operator FAIL reproduced: {fail_rec}/{len(fail_rows)}")
    dis = [r for r in ok if not r["agree"]]
    if dis:
        print("[judge]   disagreements:")
        for r in dis:
            print(f"     {r['key']:28} operator={r['label']} judge={r['judge']} — {r['reason'][:90]}")
    print("=" * 60)
    out = os.path.join(os.path.dirname(BASELINE_RESULTS), "judge_calibration.json")
    json.dump(rows, open(out, "w", encoding="utf-8"), indent=2)
    print(f"[judge] detail -> {out}")


if __name__ == "__main__":
    main()

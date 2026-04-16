"""
anomaly_report.py
CleanShot Pipeline — Step 5
Reads all pipeline output files and produces a human-readable HTML report
summarizing parsing anomalies, filter rejections, captioning errors, and
dataset balance analysis. Open the output in any browser.

Usage:
    python scripts/anomaly_report.py

Inputs (any that exist):
    output/folder_index.json
    output/anomaly_log.json
    output/filter_pass.json
    output/filter_reject.json
    output/filter_summary.json
    output/pass1_cache.json
    output/caption_cache.json
    output/batch_error_log.json
    output/manifests/upload_log.json
    output/manifests/rejected_captions.json

Outputs:
    output/pipeline_report.html   — open in browser
    output/pipeline_report.json   — machine-readable version of the same data
"""

import json
import os
from pathlib import Path
from collections import Counter, defaultdict
from datetime import datetime
from dotenv import load_dotenv

load_dotenv()

# ── OUTPUT PATHS ──────────────────────────────────────────────────────────────
OUTPUT_DIR      = Path("./output")
REPORT_HTML     = OUTPUT_DIR / "pipeline_report.html"
REPORT_JSON     = OUTPUT_DIR / "pipeline_report.json"

# ── INPUT PATHS ───────────────────────────────────────────────────────────────
FOLDER_INDEX    = OUTPUT_DIR / "folder_index.json"
ANOMALY_LOG     = OUTPUT_DIR / "anomaly_log.json"
FILTER_PASS     = OUTPUT_DIR / "filter_pass.json"
FILTER_REJECT   = OUTPUT_DIR / "filter_reject.json"
FILTER_SUMMARY  = OUTPUT_DIR / "filter_summary.json"
PASS1_CACHE     = OUTPUT_DIR / "pass1_cache.json"
CAPTION_CACHE   = OUTPUT_DIR / "caption_cache.json"
BATCH_ERRORS    = OUTPUT_DIR / "batch_error_log.json"
UPLOAD_LOG      = OUTPUT_DIR / "manifests" / "upload_log.json"
REJECTED_CAPS   = OUTPUT_DIR / "manifests" / "rejected_captions.json"


# ── DATA LOADING ──────────────────────────────────────────────────────────────
def load_json(path: Path) -> dict | list | None:
    if path.exists():
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    return None


# ── SECTION BUILDERS ──────────────────────────────────────────────────────────

def build_parser_section(index: list, anomaly_log: list) -> dict:
    if not index:
        return {"available": False}

    total       = len(index)
    excluded    = sum(1 for e in (anomaly_log or []) if e.get("excluded"))
    included    = total
    with_anom   = sum(1 for e in (anomaly_log or []) if not e.get("excluded"))
    clean       = included - with_anom
    total_imgs  = sum(e.get("image_count", 0) for e in index)
    superseded  = sum(1 for e in index if e.get("is_latest_version") is False)

    # Fuel distribution
    fuel_counts = Counter()
    for e in index:
        fuel_counts[e.get("fuel_type") or "Unknown"] += 1

    # Make distribution
    make_counts = Counter()
    for e in index:
        make_counts[e.get("make") or "Unknown"] += 1

    # Tire distribution
    tire_counts = Counter()
    for e in index:
        tire_counts[e.get("tire_type") or "Unknown"] += 1

    # Anomaly type breakdown (included only)
    anom_types = Counter()
    for entry in (anomaly_log or []):
        if not entry.get("excluded"):
            for a in entry.get("anomalies", []):
                anom_types[a.split(":")[0]] += 1

    # High priority anomalies
    high = [
        e for e in (anomaly_log or [])
        if not e.get("excluded") and len(e.get("anomalies", [])) >= 3
    ]

    return {
        "available":       True,
        "total_folders":   total,
        "excluded":        excluded,
        "included":        included,
        "clean":           clean,
        "with_anomalies":  with_anom,
        "total_images":    total_imgs,
        "superseded":      superseded,
        "fuel_counts":     dict(fuel_counts.most_common()),
        "make_counts":     dict(make_counts.most_common(20)),
        "tire_counts":     dict(tire_counts.most_common()),
        "anomaly_types":   dict(anom_types.most_common()),
        "high_priority":   [{"folder": e["folder"], "anomalies": e["anomalies"]} for e in high],
    }


def build_filter_section(filter_pass: list, filter_reject: list,
                          filter_summary: dict) -> dict:
    if filter_summary is None and not filter_pass and not filter_reject:
        return {"available": False}

    total    = (filter_summary or {}).get("total_images", 0)
    passed   = len(filter_pass or [])
    rejected = len(filter_reject or [])
    dupes    = (filter_summary or {}).get("duplicates", 0)
    blurry   = (filter_summary or {}).get("blurry_flagged", 0)
    skip     = (filter_summary or {}).get("superseded_folders_skipped", 0)

    # Rejection reason breakdown
    reason_counts = Counter()
    for r in (filter_reject or []):
        for reason in r.get("reject_reasons", []):
            reason_counts[reason.split(":")[0]] += 1

    # Make pass/reject breakdown
    make_stats = defaultdict(lambda: {"pass": 0, "reject": 0})
    for img in (filter_pass or []):
        make = (img.get("metadata") or {}).get("make", "Unknown")
        make_stats[make]["pass"] += 1
    for img in (filter_reject or []):
        make = (img.get("metadata") or {}).get("make", "Unknown")
        make_stats[make]["reject"] += 1

    return {
        "available":      True,
        "total":          total,
        "passed":         passed,
        "rejected":       rejected,
        "duplicates":     dupes,
        "blurry_flagged": blurry,
        "superseded_skip":skip,
        "pass_pct":       round(passed / total * 100, 1) if total else 0,
        "reject_reasons": dict(reason_counts.most_common()),
        "make_stats":     {k: dict(v) for k, v in sorted(
                            make_stats.items(), key=lambda x: -x[1]["pass"])[:20]},
    }


def build_caption_section(pass1_cache: dict, caption_cache: dict,
                           batch_errors: list) -> dict:
    if not pass1_cache and not caption_cache:
        return {"available": False}

    # Pass 1 score distribution
    p1_scores = Counter()
    if pass1_cache:
        for v in pass1_cache.values():
            if isinstance(v, dict):
                score = v.get("quality_score")
                if score:
                    p1_scores[score] += 1

    p1_passing = sum(c for s, c in p1_scores.items() if s >= 4)
    p1_failing = sum(c for s, c in p1_scores.items() if s < 4)

    # Pass 2 stats
    p2_total  = len(caption_cache or {})

    # Angle distribution
    angle_dist = Counter()
    env_dist   = Counter()
    cond_dist  = Counter()
    score_dist = Counter()
    flagged    = 0

    for v in (caption_cache or {}).values():
        if isinstance(v, dict):
            angle_dist[v.get("angle", "unknown")] += 1
            env_dist[v.get("environment", "unknown")] += 1
            cond_dist[v.get("condition", "unknown")] += 1
            s = v.get("quality_score")
            if s:
                score_dist[s] += 1
            if v.get("flagged"):
                flagged += 1

    # Batch errors
    error_types = Counter()
    for e in (batch_errors or []):
        error_types[e.get("error", "unknown")] += 1

    return {
        "available":      True,
        "pass1_total":    len(pass1_cache or {}),
        "pass1_passing":  p1_passing,
        "pass1_failing":  p1_failing,
        "pass1_scores":   dict(sorted(p1_scores.items())),
        "pass2_total":    p2_total,
        "flagged":        flagged,
        "angle_dist":     dict(angle_dist.most_common()),
        "env_dist":       dict(env_dist.most_common()),
        "cond_dist":      dict(cond_dist.most_common()),
        "score_dist":     dict(sorted(score_dist.items(), reverse=True)),
        "error_types":    dict(error_types.most_common()),
        "error_count":    len(batch_errors or []),
    }


def build_manifest_section(upload_log: dict, rejected_caps: list) -> dict:
    if not upload_log and not rejected_caps:
        return {"available": False}

    total_up  = (upload_log or {}).get("total_uploaded", 0)
    total_fail= (upload_log or {}).get("total_failed", 0)
    rej_count = len(rejected_caps or [])

    # Split counts from upload log
    split_counts = Counter()
    for entry in (upload_log or {}).get("log", []):
        split_counts[entry.get("split", "unknown")] += 1

    # Rejection reason breakdown
    cap_reasons = Counter()
    for r in (rejected_caps or []):
        for reason in r.get("rejection_reasons", []):
            cap_reasons[reason.split(":")[0]] += 1

    return {
        "available":        True,
        "total_uploaded":   total_up,
        "total_failed":     total_fail,
        "rejected_captions":rej_count,
        "split_counts":     dict(split_counts),
        "cap_reject_reasons": dict(cap_reasons.most_common()),
    }


# ── HTML RENDERING ────────────────────────────────────────────────────────────

def pct_bar(value: int, total: int, color: str = "#1F3FB9") -> str:
    pct = (value / total * 100) if total > 0 else 0
    return (f'<div style="background:#eee;border-radius:4px;height:16px;width:100%">'
            f'<div style="background:{color};width:{pct:.1f}%;height:100%;'
            f'border-radius:4px;min-width:2px"></div></div>'
            f'<small style="color:#666">{value:,} ({pct:.1f}%)</small>')


def kpi(label: str, value: str, color: str = "#1F3FB9") -> str:
    return (f'<div style="background:{color};color:white;border-radius:8px;'
            f'padding:16px 20px;margin:6px;display:inline-block;min-width:140px;text-align:center">'
            f'<div style="font-size:28px;font-weight:bold">{value}</div>'
            f'<div style="font-size:12px;opacity:0.85;margin-top:4px">{label}</div>'
            f'</div>')


def section(title: str, content: str, status: str = "") -> str:
    badge = ""
    if status == "complete":
        badge = '<span style="background:#1E7E4E;color:white;border-radius:4px;padding:2px 8px;font-size:12px;margin-left:8px">COMPLETE</span>'
    elif status == "pending":
        badge = '<span style="background:#8A5A00;color:white;border-radius:4px;padding:2px 8px;font-size:12px;margin-left:8px">PENDING</span>'
    elif status == "partial":
        badge = '<span style="background:#1F3FB9;color:white;border-radius:4px;padding:2px 8px;font-size:12px;margin-left:8px">IN PROGRESS</span>'

    return (f'<div style="background:white;border-radius:8px;border:1px solid #ddd;'
            f'margin:20px 0;overflow:hidden">'
            f'<div style="background:#1F3FB9;color:white;padding:14px 20px;'
            f'font-size:18px;font-weight:bold">{title}{badge}</div>'
            f'<div style="padding:20px">{content}</div>'
            f'</div>')


def dist_table(data: dict, col1: str = "Value", col2: str = "Count",
               total: int = 0) -> str:
    if not data:
        return "<p style='color:#999'>No data available.</p>"

    rows = ""
    for k, v in list(data.items())[:25]:
        bar = pct_bar(v, total or sum(data.values())) if total or data else ""
        rows += f"<tr><td style='padding:6px 12px;border-bottom:1px solid #f0f0f0'>{k}</td><td style='padding:6px 12px;border-bottom:1px solid #f0f0f0;text-align:right'>{v:,}</td><td style='padding:6px 12px;border-bottom:1px solid #f0f0f0;min-width:160px'>{bar}</td></tr>"

    return (f'<table style="width:100%;border-collapse:collapse;font-size:14px">'
            f'<thead><tr>'
            f'<th style="text-align:left;padding:8px 12px;background:#f5f7ff;border-bottom:2px solid #1F3FB9">{col1}</th>'
            f'<th style="text-align:right;padding:8px 12px;background:#f5f7ff;border-bottom:2px solid #1F3FB9">{col2}</th>'
            f'<th style="padding:8px 12px;background:#f5f7ff;border-bottom:2px solid #1F3FB9"></th>'
            f'</tr></thead><tbody>{rows}</tbody></table>')


def render_html(parser: dict, filter_: dict, caption: dict,
                manifest: dict, generated_at: str) -> str:

    # ── Parser section ────────────────────────────────────────────────────────
    if parser["available"]:
        p_status = "complete"
        p_kpis = (
            kpi("Total Folders", f"{parser['total_folders']:,}") +
            kpi("Excluded (No Year)", f"{parser['excluded']:,}", "#8A5A00") +
            kpi("Included", f"{parser['included']:,}", "#1E7E4E") +
            kpi("With Anomalies", f"{parser['with_anomalies']:,}", "#B91C1C") +
            kpi("Total Images", f"{parser['total_images']:,}")
        )
        p_tables = (
            "<h3 style='color:#1F3FB9;margin-top:20px'>Anomaly Types</h3>" +
            dist_table(parser["anomaly_types"], "Anomaly Type", "Count") +
            "<h3 style='color:#1F3FB9;margin-top:20px'>Fuel Type Distribution</h3>" +
            dist_table(parser["fuel_counts"], "Fuel Type", "Folders") +
            "<h3 style='color:#1F3FB9;margin-top:20px'>Tire Type Distribution</h3>" +
            dist_table(parser["tire_counts"], "Tire Type", "Folders") +
            "<h3 style='color:#1F3FB9;margin-top:20px'>Make Distribution (Top 20)</h3>" +
            dist_table(parser["make_counts"], "Make", "Folders")
        )
        hp = parser.get("high_priority", [])
        hp_html = ""
        if hp:
            hp_rows = "".join(
                f"<tr><td style='padding:6px 12px;border-bottom:1px solid #f0f0f0;font-family:monospace;font-size:13px'>{e['folder']}</td>"
                f"<td style='padding:6px 12px;border-bottom:1px solid #f0f0f0;color:#B91C1C;font-size:13px'>{'<br>'.join(e['anomalies'])}</td></tr>"
                for e in hp
            )
            hp_html = (
                f"<h3 style='color:#B91C1C;margin-top:20px'>⚠️ High Priority Anomalies (3+ flags) — {len(hp)} folders</h3>"
                f"<table style='width:100%;border-collapse:collapse;font-size:14px'>"
                f"<thead><tr>"
                f"<th style='text-align:left;padding:8px 12px;background:#feecec;border-bottom:2px solid #B91C1C'>Folder</th>"
                f"<th style='text-align:left;padding:8px 12px;background:#feecec;border-bottom:2px solid #B91C1C'>Anomalies</th>"
                f"</tr></thead><tbody>{hp_rows}</tbody></table>"
            )
        p_content = p_kpis + p_tables + hp_html
    else:
        p_status  = "pending"
        p_content = "<p style='color:#999'>folder_parser.py has not been run yet.</p>"

    # ── Filter section ────────────────────────────────────────────────────────
    if filter_["available"]:
        f_status = "complete"
        f_kpis = (
            kpi("Total Scanned", f"{filter_['total']:,}") +
            kpi("Passed", f"{filter_['passed']:,}", "#1E7E4E") +
            kpi("Rejected", f"{filter_['rejected']:,}", "#B91C1C") +
            kpi("Duplicates", f"{filter_['duplicates']:,}", "#8A5A00") +
            kpi("Blurry (flagged)", f"{filter_['blurry_flagged']:,}", "#555")
        )
        f_content = (
            f_kpis +
            f"<p style='margin-top:16px'>Pass rate: <strong>{filter_['pass_pct']}%</strong></p>" +
            "<h3 style='color:#1F3FB9;margin-top:20px'>Rejection Reasons</h3>" +
            dist_table(filter_["reject_reasons"], "Reason", "Count") +
            "<h3 style='color:#1F3FB9;margin-top:20px'>Pass/Reject by Make (Top 20)</h3>" +
            _make_filter_table(filter_["make_stats"])
        )
    else:
        f_status  = "pending"
        f_content = "<p style='color:#999'>image_filter.py has not been run yet.</p>"

    # ── Caption section ───────────────────────────────────────────────────────
    if caption["available"]:
        c_status = "complete" if caption["pass2_total"] > 0 else "partial"
        c_kpis = (
            kpi("Pass 1 Scored", f"{caption['pass1_total']:,}") +
            kpi("Pass 1 Passing", f"{caption['pass1_passing']:,}", "#1E7E4E") +
            kpi("Pass 1 Failing", f"{caption['pass1_failing']:,}", "#B91C1C") +
            kpi("Captions Generated", f"{caption['pass2_total']:,}", "#1F3FB9") +
            kpi("Flagged by Claude", f"{caption['flagged']:,}", "#8A5A00") +
            kpi("Batch Errors", f"{caption['error_count']:,}", "#B91C1C" if caption['error_count'] > 0 else "#555")
        )
        c_content = (
            c_kpis +
            "<h3 style='color:#1F3FB9;margin-top:20px'>Quality Score Distribution</h3>" +
            dist_table(caption["score_dist"], "Score", "Count") +
            "<h3 style='color:#1F3FB9;margin-top:20px'>Angle Distribution</h3>" +
            dist_table(caption["angle_dist"], "Angle", "Count") +
            "<h3 style='color:#1F3FB9;margin-top:20px'>Environment Distribution</h3>" +
            dist_table(caption["env_dist"], "Environment", "Count") +
            "<h3 style='color:#1F3FB9;margin-top:20px'>Condition Distribution</h3>" +
            dist_table(caption["cond_dist"], "Condition", "Count")
        )
        if caption["error_count"] > 0:
            c_content += (
                "<h3 style='color:#B91C1C;margin-top:20px'>Batch Error Types</h3>" +
                dist_table(caption["error_types"], "Error Type", "Count") +
                "<p style='color:#B91C1C'>Re-run with: <code>python scripts/captioner.py --retry</code></p>"
            )
    else:
        c_status  = "pending"
        c_content = "<p style='color:#999'>captioner.py has not been run yet.</p>"

    # ── Manifest section ──────────────────────────────────────────────────────
    if manifest["available"]:
        m_status = "complete"
        m_kpis = (
            kpi("Uploaded to GCS", f"{manifest['total_uploaded']:,}", "#1E7E4E") +
            kpi("Upload Failures", f"{manifest['total_failed']:,}", "#B91C1C" if manifest['total_failed'] > 0 else "#555") +
            kpi("Captions Rejected", f"{manifest['rejected_captions']:,}", "#8A5A00")
        )
        split_str = " | ".join(f"{k}: {v:,}" for k, v in manifest["split_counts"].items())
        m_content = (
            m_kpis +
            f"<p style='margin-top:16px'><strong>Split:</strong> {split_str}</p>" +
            f"<p><strong>GCS Bucket:</strong> <code>gs://{os.getenv('GCS_BUCKET', 'cleanshot-training-df-2026')}/</code></p>" +
            "<h3 style='color:#1F3FB9;margin-top:20px'>Caption Rejection Reasons</h3>" +
            dist_table(manifest["cap_reject_reasons"], "Reason", "Count")
        )
    else:
        m_status  = "pending"
        m_content = "<p style='color:#999'>manifest_builder.py has not been run yet.</p>"

    # ── Overall status bar ────────────────────────────────────────────────────
    steps = [
        ("Step 1: Folder Parser",   parser["available"],  "folder_parser.py"),
        ("Step 2: Image Filter",    filter_["available"], "image_filter.py"),
        ("Step 3: Captioner",       caption["available"], "captioner.py"),
        ("Step 4: Manifest Builder",manifest["available"],"manifest_builder.py"),
    ]
    status_bars = ""
    for name, done, script in steps:
        color  = "#1E7E4E" if done else "#ddd"
        tcolor = "white"   if done else "#999"
        label  = "✅ Complete" if done else f"⏳ Run {script}"
        status_bars += (
            f'<div style="background:{color};color:{tcolor};border-radius:6px;'
            f'padding:10px 16px;margin:6px 0;font-size:14px">'
            f'<strong>{name}</strong> — {label}</div>'
        )

    # ── Full HTML ──────────────────────────────────────────────────────────────
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>CleanShot Pipeline Report</title>
<style>
  body {{ font-family: Arial, sans-serif; background: #f0f4fb; margin: 0; padding: 24px; color: #1A1A2E; }}
  h1 {{ color: #1F3FB9; }} h2 {{ color: #1F3FB9; }}
  code {{ background: #f0f0f0; padding: 2px 6px; border-radius: 3px; font-size: 13px; }}
  table {{ border-radius: 6px; overflow: hidden; }}
</style>
</head>
<body>
<h1>🏗️ CleanShot Pipeline Report</h1>
<p style="color:#666">Generated: {generated_at} &nbsp;|&nbsp;
   GCS Bucket: <code>{os.getenv('GCS_BUCKET','cleanshot-training-df-2026')}</code> &nbsp;|&nbsp;
   Project: <code>{os.getenv('GCP_PROJECT_ID','cleanshot-493512')}</code>
</p>

<div style="background:white;border-radius:8px;border:1px solid #ddd;padding:20px;margin-bottom:20px">
  <h2 style="margin-top:0">Pipeline Status</h2>
  {status_bars}
</div>

{section("Step 1 — Folder Parser", p_content, p_status)}
{section("Step 2 — Image Filter", f_content, f_status)}
{section("Step 3 — Captioner", c_content, c_status)}
{section("Step 4 — Manifest Builder", m_content, m_status)}

<p style="color:#999;font-size:12px;text-align:center;margin-top:40px">
  CleanShot Pipeline — Phase 1 &nbsp;|&nbsp; Re-run anomaly_report.py at any time to refresh.
</p>
</body>
</html>"""


def _make_filter_table(make_stats: dict) -> str:
    if not make_stats:
        return "<p style='color:#999'>No data.</p>"
    rows = ""
    for make, counts in list(make_stats.items())[:20]:
        total  = counts["pass"] + counts["reject"]
        pct    = counts["pass"] / total * 100 if total else 0
        bar    = pct_bar(counts["pass"], total, "#1E7E4E")
        rows  += (f"<tr>"
                  f"<td style='padding:6px 12px;border-bottom:1px solid #f0f0f0'>{make}</td>"
                  f"<td style='padding:6px 12px;border-bottom:1px solid #f0f0f0;text-align:right;color:#1E7E4E'>{counts['pass']:,}</td>"
                  f"<td style='padding:6px 12px;border-bottom:1px solid #f0f0f0;text-align:right;color:#B91C1C'>{counts['reject']:,}</td>"
                  f"<td style='padding:6px 12px;border-bottom:1px solid #f0f0f0;min-width:160px'>{bar}</td>"
                  f"</tr>")
    return (f'<table style="width:100%;border-collapse:collapse;font-size:14px">'
            f'<thead><tr>'
            f'<th style="text-align:left;padding:8px 12px;background:#f5f7ff;border-bottom:2px solid #1F3FB9">Make</th>'
            f'<th style="text-align:right;padding:8px 12px;background:#f5f7ff;border-bottom:2px solid #1F3FB9">Pass</th>'
            f'<th style="text-align:right;padding:8px 12px;background:#f5f7ff;border-bottom:2px solid #1F3FB9">Reject</th>'
            f'<th style="padding:8px 12px;background:#f5f7ff;border-bottom:2px solid #1F3FB9">Pass Rate</th>'
            f'</tr></thead><tbody>{rows}</tbody></table>')


# ── MAIN ──────────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    print("CleanShot Pipeline — Anomaly Report Generator")
    print("="*60)

    # Load all available data
    print("Loading pipeline outputs...")
    index          = load_json(FOLDER_INDEX)   or []
    anomaly_log    = load_json(ANOMALY_LOG)    or []
    filter_pass    = load_json(FILTER_PASS)    or []
    filter_reject  = load_json(FILTER_REJECT)  or []
    filter_summary = load_json(FILTER_SUMMARY) or {}
    pass1_cache    = load_json(PASS1_CACHE)    or {}
    caption_cache  = load_json(CAPTION_CACHE)  or {}
    batch_errors   = load_json(BATCH_ERRORS)   or []
    upload_log     = load_json(UPLOAD_LOG)     or {}
    rejected_caps  = load_json(REJECTED_CAPS)  or []

    files_found = [
        p.name for p in [
            FOLDER_INDEX, ANOMALY_LOG, FILTER_PASS, FILTER_REJECT,
            FILTER_SUMMARY, PASS1_CACHE, CAPTION_CACHE, BATCH_ERRORS,
            UPLOAD_LOG, REJECTED_CAPS,
        ] if p.exists()
    ]
    print(f"  Found {len(files_found)} output files: {', '.join(files_found)}")

    # Build report sections
    print("Building report sections...")
    parser_data   = build_parser_section(index, anomaly_log)
    filter_data   = build_filter_section(filter_pass, filter_reject, filter_summary)
    caption_data  = build_caption_section(pass1_cache, caption_cache, batch_errors)
    manifest_data = build_manifest_section(upload_log, rejected_caps)

    generated_at  = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    # Render HTML
    html = render_html(parser_data, filter_data, caption_data,
                       manifest_data, generated_at)

    # Save HTML report
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    with open(REPORT_HTML, "w", encoding="utf-8") as f:
        f.write(html)

    # Save JSON report
    report_json = {
        "generated_at": generated_at,
        "parser":        parser_data,
        "filter":        filter_data,
        "caption":       caption_data,
        "manifest":      manifest_data,
    }
    with open(REPORT_JSON, "w", encoding="utf-8") as f:
        json.dump(report_json, f, indent=2, ensure_ascii=False)

    print(f"\nReports written:")
    print(f"  HTML  -> {REPORT_HTML}")
    print(f"  JSON  -> {REPORT_JSON}")
    print(f"\nOpen output/pipeline_report.html in your browser to view the report.")

    # Print quick console summary
    print("\n" + "="*60)
    print("QUICK SUMMARY")
    print("="*60)

    if parser_data["available"]:
        print(f"Parser:    {parser_data['total_folders']:,} folders  |  "
              f"{parser_data['excluded']:,} excluded  |  "
              f"{parser_data['total_images']:,} images  |  "
              f"{parser_data['with_anomalies']:,} anomalies")

    if filter_data["available"]:
        print(f"Filter:    {filter_data['passed']:,} passed  |  "
              f"{filter_data['rejected']:,} rejected  |  "
              f"{filter_data['pass_pct']}% pass rate")

    if caption_data["available"]:
        print(f"Captions:  {caption_data['pass2_total']:,} generated  |  "
              f"{caption_data['flagged']:,} flagged  |  "
              f"{caption_data['error_count']:,} errors")

    if manifest_data["available"]:
        splits = manifest_data.get("split_counts", {})
        split_str = "  |  ".join(f"{k}: {v:,}" for k, v in splits.items())
        print(f"Manifest:  {manifest_data['total_uploaded']:,} uploaded  |  {split_str}")

    print("="*60)

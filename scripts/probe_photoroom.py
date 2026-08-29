#!/usr/bin/env python3
"""
Probe: does Photoroom's matting beat fal BiRefNet on our failure case?

THE BUDGET IS THE DESIGN CONSTRAINT
-----------------------------------
The free tier is TEN IMAGES, total, ever. That is not enough to discover the
request shape by trial and error, so this script is built to make wasting a
call difficult:

  • --dry-run builds and prints the exact request WITHOUT sending it. Free.
    Run this first, every time you change a parameter.
  • A LEDGER at <out>/photoroom-ledger.json counts every call ever made from
    this script and refuses to pass --budget (default 10). It survives reruns,
    so a forgotten earlier session cannot silently overspend.
  • Every response is written to disk raw, before any processing. A saved
    response can be re-examined forever; a discarded one costs another credit.

WHAT WE ARE ACTUALLY TESTING
----------------------------
BiRefNet "General Use" is a SALIENT OBJECT detector, so the first real cutout
came back with the forklift AND a showroom plant AND a wall banner all carrying
alpha. Photoroom is trained on PRODUCT photography — one subject on a
background — which is a better prior for our job. Whether that prior actually
excludes a plant standing beside a forklift is the question. Everything else
(edge quality on mast lattice, fork gaps) is secondary and judged by eye from
the artifacts.

ASK FOR THE MASK, NOT THE CUTOUT
--------------------------------
services/cutout.py deliberately requests a MASK and composites locally, so the
approved RGB is never re-encoded by a vendor. Photoroom's `channels=alpha`
should return a bare alpha mask rather than a finished cutout, which keeps that
property. VERIFY THAT ON THE FIRST CALL — if what comes back is a full RGBA
cutout instead, this is an architectural decision rather than a drop-in swap,
and worth stopping to think about before spending the other nine.

`size=preview` may be cheaper or unbilled on the free tier — worth checking the
dashboard after call one, because if it is free you can test subject-selection
behaviour without spending the ten on full-resolution runs.

RUNNING IT
----------
  python -m venv .probe-venv
  .probe-venv/Scripts/python -m pip install "pyvips[binary]"
  export PHOTOROOM_API_KEY=...      # or pass --key

  # free — always do this first
  .probe-venv/Scripts/python scripts/probe_photoroom.py --dry-run test-fixtures/*.jpg

  # spends exactly one credit
  .probe-venv/Scripts/python scripts/probe_photoroom.py --max-calls 1 the-failing-one.png

pyvips is optional: with it you get a composite and a blob count, without it
the raw responses are still saved.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

ENDPOINT = "https://sdk.photoroom.com/v1/segment"

# Photoroom authenticates with a bare `x-api-key` header — NOT Bearer, and not
# Authorization at all. A wrong scheme here returns 401, which is
# indistinguishable from a bad key and burns a debugging session, not a credit.
AUTH_HEADER = "x-api-key"

# Hard ceiling across every run of this script. The ledger enforces it.
DEFAULT_BUDGET = 10


def _multipart(fields: dict[str, str], filename: str, blob: bytes) -> tuple[bytes, str]:
    """Minimal multipart/form-data encoder. Stdlib only, like scripts/holistic_judge.py."""
    boundary = "----probe" + uuid.uuid4().hex
    out: list[bytes] = []
    for key, value in fields.items():
        out.append(
            f'--{boundary}\r\nContent-Disposition: form-data; name="{key}"\r\n\r\n'
            f"{value}\r\n".encode()
        )
    out.append(
        f'--{boundary}\r\nContent-Disposition: form-data; name="image_file"; '
        f'filename="{filename}"\r\nContent-Type: application/octet-stream\r\n\r\n'.encode()
    )
    out.append(blob)
    out.append(f"\r\n--{boundary}--\r\n".encode())
    return b"".join(out), f"multipart/form-data; boundary={boundary}"


def _ledger_path(out: Path) -> Path:
    return out / "photoroom-ledger.json"


def _read_ledger(out: Path) -> dict:
    path = _ledger_path(out)
    if not path.exists():
        return {"calls": 0, "log": []}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        # A corrupt ledger must not read as "zero calls spent" — that is the
        # one failure mode that silently burns the budget.
        print("!! ledger unreadable; refusing to spend. Fix or delete it deliberately.")
        sys.exit(2)


def _write_ledger(out: Path, ledger: dict) -> None:
    _ledger_path(out).write_text(json.dumps(ledger, indent=2), encoding="utf-8")


def _describe(vips, blob: bytes) -> str:
    """Dimensions, coverage, and a blob count — the blob count is the plant detector."""
    img = vips.Image.new_from_buffer(blob, "")
    bits = [f"{img.width}x{img.height}", f"{img.bands} bands", f"alpha={img.hasalpha()}"]

    band = img[3] if img.hasalpha() else img[0]
    bits.append(f"coverage {band.avg() / 255.0 * 100:.1f}%")
    try:
        labels = (band > 127).ifthenelse(1, 0).labelregions()
        # labelregions numbers regions of EQUAL value, so background regions
        # count too — an upper bound on foreground blobs, not an exact count.
        # Still distinguishes "just the machine" from "machine plus plant".
        bits.append(f"<={int(labels.max())} regions")
    except Exception as exc:
        bits.append(f"(blobs unavailable: {type(exc).__name__})")
    return ", ".join(bits)


def _composite(vips, image_path: Path, mask_blob: bytes) -> bytes:
    """
    Mirror of services/cutout.py::_composite_alpha so what we look at is what
    production would ship. Kept in sync BY HAND — if that changes, this lies.
    """
    img = vips.Image.new_from_file(str(image_path))
    if img.hasalpha():
        img = img.flatten(background=[255, 255, 255])

    mask = vips.Image.new_from_buffer(mask_blob, "")
    if mask.hasalpha():
        mask = mask[3]
    elif mask.bands > 1:
        mask = mask[0]

    if mask.width != img.width or mask.height != img.height:
        mask = mask.resize(
            img.width / mask.width, vscale=img.height / mask.height, kernel="linear"
        )
    return img.bandjoin(mask.cast("uchar")).copy(interpretation="srgb").write_to_buffer(".png")


def main() -> int:
    ap = argparse.ArgumentParser(description="Photoroom matting probe (budget-capped)")
    ap.add_argument("images", nargs="+", type=Path)
    ap.add_argument("--key", default=os.environ.get("PHOTOROOM_API_KEY", ""))
    ap.add_argument("--out", type=Path, default=Path("probe-out"))
    ap.add_argument("--channels", default="alpha", choices=("alpha", "rgba"))
    ap.add_argument("--size", default="full", choices=("preview", "medium", "hd", "full"))
    ap.add_argument("--budget", type=int, default=DEFAULT_BUDGET,
                    help="lifetime cap enforced by the ledger")
    ap.add_argument("--max-calls", type=int, default=1,
                    help="cap for THIS run; deliberately defaults to 1")
    ap.add_argument("--dry-run", action="store_true",
                    help="build and print the request without sending it (free)")
    args = ap.parse_args()

    args.out.mkdir(parents=True, exist_ok=True)
    ledger = _read_ledger(args.out)
    remaining = args.budget - ledger["calls"]

    if not args.dry_run:
        if not args.key:
            print("No API key. Set PHOTOROOM_API_KEY or pass --key.")
            return 2
        if remaining <= 0:
            print(f"Budget exhausted: {ledger['calls']}/{args.budget} calls already spent.")
            print(f"Ledger: {_ledger_path(args.out)}")
            return 1

    print(f"Budget: {ledger['calls']}/{args.budget} spent, {remaining} left. "
          f"This run will make at most {min(args.max_calls, max(remaining, 0))} call(s).")

    try:
        import pyvips
        vips = pyvips
    except Exception:
        vips = None
        print("NOTE: pyvips unavailable — saving raw responses only.\n")

    spent = 0
    for image_path in args.images:
        if not image_path.exists():
            print(f"!! missing: {image_path}")
            continue
        if spent >= args.max_calls:
            print(f"\nStopping: hit --max-calls {args.max_calls}.")
            break
        if not args.dry_run and ledger["calls"] >= args.budget:
            print("\nStopping: budget exhausted mid-run.")
            break

        blob = image_path.read_bytes()
        fields = {"format": "png", "channels": args.channels, "size": args.size}
        body, content_type = _multipart(fields, image_path.name, blob)

        print(f"\n=== {image_path.name} ({len(blob)} bytes) ===")
        print(f"  POST {ENDPOINT}")
        print(f"  headers: {AUTH_HEADER}: <{len(args.key)}-char key>, Content-Type: {content_type[:46]}...")
        print(f"  fields:  {fields}")
        print(f"  body:    {len(body)} bytes")

        if args.dry_run:
            print("  DRY RUN -- not sent, nothing spent.")
            continue

        req = urllib.request.Request(
            ENDPOINT,
            data=body,
            headers={AUTH_HEADER: args.key, "Content-Type": content_type,
                     "Accept": "image/png, application/json"},
            method="POST",
        )

        t0 = time.monotonic()
        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                payload = resp.read()
                status = resp.status
                ctype = resp.headers.get("Content-Type", "?")
        except urllib.error.HTTPError as exc:
            detail = exc.read()[:600].decode("utf-8", "replace")
            # A 4xx still counts against nothing on most tiers, but log it as a
            # call anyway — assuming a failed call was free is how budgets go.
            ledger["calls"] += 1
            ledger["log"].append({"image": image_path.name, "status": exc.code,
                                  "error": detail})
            _write_ledger(args.out, ledger)
            print(f"  HTTP {exc.code}: {detail}")
            continue
        except Exception as exc:
            print(f"  transport error (not counted): {type(exc).__name__}: {exc}")
            continue

        dt = (time.monotonic() - t0) * 1000
        spent += 1
        ledger["calls"] += 1
        ledger["log"].append({"image": image_path.name, "status": status,
                              "bytes": len(payload), "content_type": ctype,
                              "channels": args.channels, "size": args.size})
        _write_ledger(args.out, ledger)

        # Save BEFORE processing. A saved response can be re-read forever.
        stem = f"{image_path.stem}.{args.channels}.{args.size}"
        raw = args.out / f"{stem}.response.png"
        raw.write_bytes(payload)
        print(f"  HTTP {status} {ctype} {len(payload)} bytes in {dt:.0f}ms -> {raw.name}")

        if vips:
            try:
                print(f"  {_describe(vips, payload)}")
            except Exception as exc:
                print(f"  could not read response as an image: {exc}")
            if args.channels == "alpha":
                try:
                    (args.out / f"{stem}.cutout.png").write_bytes(
                        _composite(vips, image_path, payload)
                    )
                    print(f"  composite -> {stem}.cutout.png")
                except Exception as exc:
                    print(f"  composite failed: {exc}")

    print(f"\nBudget now {ledger['calls']}/{args.budget}. Artifacts: {args.out.resolve()}")
    if not args.dry_run:
        print("Check: is the response a BARE ALPHA MASK (1 band) or a full RGBA")
        print("cutout? That decides whether this is a drop-in for fal or a rethink.")
    return 0


if __name__ == "__main__":
    sys.exit(main())

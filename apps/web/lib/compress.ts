// apps/web/lib/compress.ts
// Client-side image compression + format normalization using Canvas API.
//
// Every uploaded image is now re-encoded as JPEG before reaching GCS.
// Rationale:
//   • Standardizes input for the Gemini worker (strips embedded metadata,
//     color-profile quirks, and odd container variants that have caused
//     model refusals on real customer uploads).
//   • Keeps downstream pipelines (scan / resize / export) format-stable.
//   • Lets us deterministically name the GCS object from the forklift
//     details the user entered, instead of whatever-the-source-was.
//
// FILE SIZE is compressed; RESOLUTION is not capped (2026-08-21).
//
// The old `MAX_LONG_EDGE = 1024` downscale is gone. Enhanced output is now
// standardised at 2800x2000, so handing the model a 1024px source meant
// upscaling generated pixels ~2.7x on the way out — correctly-sized but soft.
// Full-resolution sources give the model real detail to work with.
//
// Byte compression stays, for two reasons that are NOT the one originally
// written here: uploads are faster, and the AI providers have their own
// per-image byte limits. The original rationale — Vercel's 4.5 MB serverless
// body limit — never actually applied to this path: uploads go straight to
// GCS via a signed PUT (see uploadToGcs in lib/api.ts), so the image bytes
// never traverse a Vercel function.
//
// The quality loop is now BEST-EFFORT rather than a hard gate. At full
// resolution a large photo may not reach the target even at minimum quality,
// and failing the upload over that is worse than uploading a bigger file to a
// bucket that does not care.
// ─── HEIC ─────────────────────────────────────────────────────────────────────
//
// iPhones shoot HEIC by default, and `createImageBitmap` CANNOT decode it in
// Chrome or Firefox — only Safari can, because it is the only browser with a
// system HEIC codec. So without this an iPhone upload throws inside
// convertToJpeg and the upload fails outright, with an error that reads like a
// corrupt file rather than an unsupported format.
//
// Detection is by MAGIC BYTES, not `file.type` or the extension. Browsers
// frequently report an EMPTY type for .heic (notably Chrome on Windows), and an
// extension can lie, so sniffing the container is the only reliable test.
//
// The decoder is DYNAMICALLY IMPORTED. heic-to carries a libheif WASM build of
// a couple of megabytes; loading that on every JPEG upload to serve the
// occasional iPhone photo would be a bad trade, so nothing is fetched until a
// HEIC actually arrives.

const HEIC_BRANDS = new Set([
  "heic", "heix", "hevc", "hevx", "heim", "heis", "hevm", "hevs", "mif1", "msf1",
]);

/**
 * True when these bytes are an HEIC/HEIF container.
 *
 * HEIC is ISO base media format: a 4-byte box size, then the literal "ftyp",
 * then a 4-character brand. Reading the first 12 bytes is enough and costs
 * nothing, which is what lets the WASM decoder stay behind a dynamic import.
 */
async function isHeic(file: File): Promise<boolean> {
  try {
    const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
    if (head.length < 12) return false;
    const ascii = (from: number, to: number) =>
      String.fromCharCode(...head.subarray(from, to));
    if (ascii(4, 8) !== "ftyp") return false;
    return HEIC_BRANDS.has(ascii(8, 12).toLowerCase());
  } catch {
    // An unreadable slice is not this function's problem to report; the decode
    // below will fail far more informatively.
    return false;
  }
}

/**
 * Decode any supported image File to an ImageBitmap.
 *
 * The single place format support is decided, so Enhance, Scan and Modify
 * cannot drift apart on which files they accept.
 *
 * HEIC is decoded straight to a bitmap rather than via an intermediate JPEG.
 * Converting HEIC -> JPEG -> canvas -> JPEG would put two lossy generations on
 * every iPhone photo before the AI ever sees it, which is exactly the detail
 * the uncapped-resolution change exists to preserve.
 */
export async function decodeToBitmap(file: File): Promise<ImageBitmap> {
  if (await isHeic(file)) {
    const { heicTo } = await import("heic-to");
    return heicTo({ blob: file, type: "bitmap" });
  }
  return createImageBitmap(file);
}

export const MAX_BYTES = 4.5 * 1024 * 1024; // 4.5 MB
const TARGET_BYTES = 4.0 * 1024 * 1024;     // 4.0 MB target after compression

/**
 * Compress a File to under TARGET_BYTES using Canvas + iterative JPEG quality reduction.
 * Returns the original File if it's already under MAX_BYTES.
 * Returns a new File (JPEG) if compression was needed.
 */
export async function compressIfNeeded(file: File): Promise<File> {
  if (file.size <= MAX_BYTES) return file;

  const bitmap = await decodeToBitmap(file);

  // Native resolution — no downscale. Only the JPEG quality is reduced below.
  const { width, height } = bitmap;

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  // Iterative quality reduction
  let quality = 0.85;
  let blob: Blob | null = null;

  for (let attempt = 0; attempt < 12; attempt++) {
    blob = await new Promise<Blob | null>((res) =>
      canvas.toBlob(res, "image/jpeg", quality)
    );
    if (blob && blob.size <= TARGET_BYTES) break;
    quality -= 0.07;
    if (quality < 0.15) break;
  }

  if (!blob) throw new Error("Compression failed: canvas.toBlob returned null");

  // Rename to .jpg so the backend knows it's been converted
  const originalName = file.name.replace(/\.[^.]+$/, "");
  return new File([blob], `${originalName}_compressed.jpg`, {
    type: "image/jpeg",
    lastModified: Date.now(),
  });
}

/** Format bytes for display in UI (e.g. "3.2 MB") */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Re-encode any image File to JPEG with the supplied filename. Used on every
 * upload so the worker always sees a deterministic JPEG.
 *
 * Steps:
 *   • Decode to ImageBitmap (handles JPEG, PNG, WebP, GIF first-frame, etc.)
 *   • Keep the source's native resolution — NOT downscaled
 *   • Composite onto a white background (PNG/WebP transparency would otherwise
 *     render as black in JPEG)
 *   • Iterative quality reduction toward TARGET_BYTES (best effort)
 */
export async function convertToJpeg(file: File, targetFilename: string): Promise<File> {
  const bitmap = await decodeToBitmap(file);

  // Native resolution — the long-edge cap is gone. Enhancement standardises
  // the OUTPUT at 2800x2000; the input should carry as much real detail into
  // the model as the photo has.
  const { width, height } = bitmap;

  const canvas = document.createElement("canvas");
  canvas.width  = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;

  // Flatten transparency onto white — JPEG has no alpha channel.
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  // Start high; reduce until under TARGET_BYTES (with MAX_BYTES as hard ceiling).
  let quality = 0.92;
  let blob: Blob | null = null;
  for (let attempt = 0; attempt < 12; attempt++) {
    blob = await new Promise<Blob | null>((res) =>
      canvas.toBlob(res, "image/jpeg", quality)
    );
    if (blob && blob.size <= TARGET_BYTES) break;
    quality -= 0.07;
    if (quality < 0.15) break;
  }

  // Best effort, not a gate. A big enough photo may not reach TARGET_BYTES
  // even at minimum quality; that is fine — it PUTs straight to GCS. Only a
  // genuine encode failure is an error.
  if (!blob) {
    throw new Error("Compression failed: canvas.toBlob returned null");
  }

  return new File([blob], targetFilename, {
    type: "image/jpeg",
    lastModified: Date.now(),
  });
}

/**
 * Build a filesystem-safe, deterministic filename from forklift details.
 * Example: meta = { make: "Toyota", model: "8FGU25", year: "2019" }, index 2 of 5
 *   →  "Toyota_8FGU25_2019_03.jpg"
 *
 * `make` is required at the call site (validated in EnhancePanel) — we still
 * fall back to "forklift" here so the function is total.
 */
export function buildEnhanceFilename(
  meta: { make?: string; model?: string; year?: string },
  index: number,
  total: number,
): string {
  const sanitize = (s: string) =>
    s
      .trim()
      .replace(/[^a-zA-Z0-9_-]+/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_|_$/g, "");

  const parts = [meta.make, meta.model, meta.year]
    .map((p) => sanitize(p ?? ""))
    .filter(Boolean);

  const base   = parts.length > 0 ? parts.join("_") : "forklift";
  const width  = total >= 100 ? 3 : total >= 10 ? 2 : 1;
  const seq    = String(index + 1).padStart(width, "0");

  return `${base}_${seq}.jpg`;
}

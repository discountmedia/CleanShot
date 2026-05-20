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
// Vercel body size limit: 4.5 MB for serverless functions. The iterative
// quality reduction below drops JPEG quality until the encoded file fits.

export const MAX_BYTES = 4.5 * 1024 * 1024; // 4.5 MB
const TARGET_BYTES = 4.0 * 1024 * 1024;     // 4.0 MB target after compression
// Long-edge cap for the image we hand to the model. 1024 was chosen as
// the upload cap so every downstream AI provider (Gemini AI Studio image
// preview, OpenAI gpt-image-2, BFL flux-2-max) sees a uniformly-sized
// input and request latency stays predictable. OpenAI /v1/images/edits
// with quality="high" on full-res smartphone photos (3-4 MP) was reliably
// blowing past a 90s server-side timeout; capping at 1024 keeps the
// model's preprocessing budget small. Bump back up if decals/text in
// scan output start reading as illegible — but verify against all three
// providers before changing.
const MAX_LONG_EDGE = 1024;

/**
 * Compress a File to under TARGET_BYTES using Canvas + iterative JPEG quality reduction.
 * Returns the original File if it's already under MAX_BYTES.
 * Returns a new File (JPEG) if compression was needed.
 */
export async function compressIfNeeded(file: File): Promise<File> {
  if (file.size <= MAX_BYTES) return file;

  const bitmap = await createImageBitmap(file);

  // Scale down if image is extremely large
  let { width, height } = bitmap;
  const longEdge = Math.max(width, height);
  if (longEdge > MAX_LONG_EDGE) {
    const scale = MAX_LONG_EDGE / longEdge;
    width = Math.round(width * scale);
    height = Math.round(height * scale);
  }

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
 *   • Scale down to MAX_LONG_EDGE if larger
 *   • Composite onto a white background (PNG/WebP transparency would otherwise
 *     render as black in JPEG)
 *   • Iterative quality reduction until under MAX_BYTES
 */
export async function convertToJpeg(file: File, targetFilename: string): Promise<File> {
  const bitmap = await createImageBitmap(file);

  let { width, height } = bitmap;
  const longEdge = Math.max(width, height);
  if (longEdge > MAX_LONG_EDGE) {
    const scale = MAX_LONG_EDGE / longEdge;
    width  = Math.round(width  * scale);
    height = Math.round(height * scale);
  }

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

  if (!blob || blob.size > MAX_BYTES) {
    throw new Error("Could not compress image under 4.5 MB even at minimum quality");
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

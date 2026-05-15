// apps/web/lib/compress.ts
// Client-side image compression using Canvas API.
// Triggered when a file exceeds MAX_BYTES (4.5 MB) before upload.
// Vercel body size limit: 4.5 MB for serverless functions.
// We compress to stay under that ceiling with margin.

export const MAX_BYTES = 4.5 * 1024 * 1024; // 4.5 MB
const TARGET_BYTES = 4.0 * 1024 * 1024;     // 4.0 MB target after compression
const MAX_LONG_EDGE = 3840;                   // 4K cap — preserves quality

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

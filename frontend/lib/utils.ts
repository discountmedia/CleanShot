/**
 * Small utility helpers.
 */

/**
 * Sanitize a filename for download. Strips path separators, drops reserved
 * characters, and caps the basename at 80 chars so we don't generate names
 * that the user's OS can't write.
 *
 * From Phase 3 v3.4: "File naming sanitizer strips reserved characters and
 * caps basename at 80 chars."
 */
export function sanitizeFilename(name: string): string {
  // Drop directory parts
  const base = name.replace(/^.*[\\/]/, "");
  // Replace reserved characters with a single dash, collapse runs
  const cleaned = base.replace(/[<>:"/\\|?*\x00-\x1f]+/g, "-").replace(/-+/g, "-");
  // Split base + extension and cap base at 80 chars
  const m = cleaned.match(/^(.*?)(\.[^.]+)?$/);
  const baseName = (m?.[1] ?? cleaned).slice(0, 80);
  const ext = m?.[2] ?? "";
  return `${baseName}${ext}`;
}

/**
 * Format bytes for the upload UI (e.g., "2.4 MB"). Uses binary units.
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * Tailwind class concatenator.
 */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

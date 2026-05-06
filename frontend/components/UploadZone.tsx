"use client";

import { useCallback, useState } from "react";
import { useDropzone } from "react-dropzone";
import { useStore } from "@/lib/store";
import { uploadFile } from "@/lib/upload";
import { cx } from "@/lib/utils";

type Props = {
  tab: "enhance" | "scan" | "resize";
};

const ACCEPT = {
  "image/jpeg": [".jpg", ".jpeg"],
  "image/png":  [".png"],
  "image/webp": [".webp"],
};

export function UploadZone({ tab }: Props) {
  const session_id = useStore((s) => s.session_id);
  const addAsset   = useStore((s) => s.addAsset);
  const setActive  = useStore((s) => s.setActive);
  const activeId   = useStore((s) => s.active[tab]);
  const assets     = useStore((s) => s.assets);

  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const onDrop = useCallback(
    async (accepted: File[]) => {
      if (!session_id) {
        setError("Session not ready yet. Wait a moment and retry.");
        return;
      }
      const file = accepted[0];
      if (!file) return;

      setError(null);
      setProgress(0);
      try {
        const rec = await uploadFile({
          session_id,
          file,
          onProgress: (p) => {
            setProgress(p.total > 0 ? Math.round((p.loaded / p.total) * 100) : 0);
          },
        });
        addAsset(rec);
        setActive(tab, rec.asset_id);
        setProgress(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : "upload_failed");
        setProgress(null);
      }
    },
    [session_id, addAsset, setActive, tab],
  );

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: ACCEPT,
    maxFiles: 1,
    multiple: false,
    disabled: progress !== null,
  });

  const activeAsset = activeId ? assets[activeId] : undefined;

  return (
    <div className="space-y-3">
      <div
        {...getRootProps()}
        className={cx(
          "flex cursor-pointer flex-col items-center justify-center rounded border-2 border-dashed px-6 py-10 text-center transition-colors",
          isDragActive
            ? "border-df-red bg-df-red-tint"
            : "border-line bg-surface-card hover:border-line-bright",
          progress !== null && "cursor-not-allowed opacity-70",
        )}
      >
        <input {...getInputProps()} />
        {progress !== null ? (
          <>
            <p className="text-xs uppercase tracking-label text-ink-muted">
              Uploading… {progress}%
            </p>
            <div className="mt-3 h-1 w-48 overflow-hidden rounded-full bg-line">
              <div
                className="h-full bg-df-red transition-all"
                style={{ width: `${progress}%` }}
              />
            </div>
          </>
        ) : (
          <>
            <p className="text-sm font-semibold uppercase tracking-label text-ink">
              {isDragActive ? "Drop the photo here" : "Drop a forklift photo"}
            </p>
            <p className="mt-1.5 text-[11px] uppercase tracking-label text-ink-dim">
              or click to browse · JPG / PNG / WebP · single file
            </p>
          </>
        )}
      </div>

      {error && (
        <div className="rounded border border-status-fail/40 bg-df-red-tint px-3 py-2 text-xs uppercase tracking-label text-status-fail">
          {error}
        </div>
      )}

      {activeAsset && progress === null && (
        <div className="flex items-center justify-between rounded border border-line bg-surface-card px-3 py-2">
          <div className="min-w-0 flex-1 truncate">
            <span className="text-sm font-medium text-ink">{activeAsset.filename}</span>
            <span className="ml-2 text-[11px] uppercase tracking-label text-ink-dim">
              {activeAsset.mime_type}
            </span>
          </div>
          <button
            type="button"
            className="text-[11px] uppercase tracking-label text-ink-dim hover:text-ink"
            onClick={() => setActive(tab, null)}
          >
            Clear
          </button>
        </div>
      )}
    </div>
  );
}

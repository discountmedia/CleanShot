// =============================================================================
//  useUpload — orchestrates session creation, upload-URL request, and direct
//  GCS PUT for one or more files. Used by all three tabs.
//
//  Returns a function `upload(files)` that:
//    1. Creates a session if one doesn't exist
//    2. For each file: requests a signed PUT URL, uploads to GCS in parallel
//    3. Registers each asset in the Zustand store as it lands
//    4. Returns the asset_ids that uploaded successfully
// =============================================================================

import { useCallback, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { useStore } from '../lib/store';
import type { UploadedAsset } from '../lib/types';

interface UseUploadResult {
  upload: (files: File[]) => Promise<string[]>;
  isUploading: boolean;
  uploadError: string | null;
}

export function useUpload(): UseUploadResult {
  const session_id = useStore((s) => s.session_id);
  const setSession = useStore((s) => s.setSession);
  const registerAsset = useStore((s) => s.registerAsset);
  const markAssetUploaded = useStore((s) => s.markAssetUploaded);
  const setAssetError = useStore((s) => s.setAssetError);

  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const upload = useCallback(
    async (files: File[]): Promise<string[]> => {
      setIsUploading(true);
      setUploadError(null);

      try {
        // 1. Ensure we have a session
        let sid = session_id;
        if (!sid) {
          const session = await api.createSession();
          sid = session.session_id;
          setSession(sid);
        }

        // 2. For each file: request URL, upload in parallel
        const uploadPromises = files.map(async (file) => {
          try {
            const { asset_id, signed_put_url } = await api.requestUploadUrl(
              sid as string,
              file.type || 'image/jpeg',
            );

            const asset: UploadedAsset = {
              asset_id,
              session_id: sid as string,
              filename: file.name,
              size_bytes: file.size,
              mime_type: file.type,
              preview_url: URL.createObjectURL(file),
              uploaded: false,
            };
            registerAsset(asset);

            await api.putToGCS(signed_put_url, file);
            markAssetUploaded(asset_id);
            return asset_id;
          } catch (err) {
            const msg = err instanceof ApiError ? err.detail : String(err);
            // best-effort: register error against any asset already created
            console.error(`Upload failed for ${file.name}:`, msg);
            return null;
          }
        });

        const results = await Promise.all(uploadPromises);
        return results.filter((id): id is string => id !== null);
      } catch (err) {
        const msg = err instanceof ApiError ? err.detail : String(err);
        setUploadError(msg);
        return [];
      } finally {
        setIsUploading(false);
      }
    },
    [session_id, setSession, registerAsset, markAssetUploaded, setAssetError],
  );

  return { upload, isUploading, uploadError };
}

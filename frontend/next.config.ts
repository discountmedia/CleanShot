import type { NextConfig } from "next";

/**
 * CleanShot web app config.
 *
 * Hosting: Vercel Pro, full Next.js runtime (NOT `output: 'export'`).
 * App Router lives at app/. See README for routing topology.
 *
 * remotePatterns covers GCS-served signed URLs for previews and results.
 * The path is opaque (asset_id + signed query) so we allow the bucket host
 * generally rather than locking down by path.
 */
const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,

  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "storage.googleapis.com",
        pathname: "/**",
      },
    ],
  },

  // Strict TS in CI. ESLint runs separately via `npm run lint` —
  // Next 16 removed the eslint integration in next.config.
  typescript: { ignoreBuildErrors: false },

  experimental: {
    // App Router is stable; no experimental flags needed for v1.
  },
};

export default config;
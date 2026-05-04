# Frontend dependencies — additions to package.json

The existing Vite/React/TS scaffold needs four runtime deps and zero
new dev deps. Run from `frontend/` (alongside `backend/` in your monorepo):

```
npm install zustand react-dropzone lucide-react
npm install -D @types/react-dropzone
```

## What each provides

| Package           | Purpose                                                      |
| ----------------- | ------------------------------------------------------------ |
| zustand           | App state store (session, assets, selection, jobs)           |
| react-dropzone    | Drag-and-drop file picker for the upload zones               |
| lucide-react      | Icon set used across tabs (Upload, Sparkles, ScanLine, etc.) |
| @types/...        | TypeScript types for react-dropzone                          |

## Environment variables

Set these in `.env.local` for dev and on Vercel for prod:

```
VITE_API_URL=https://forklift-api-387208973244.us-central1.run.app/api/v1
VITE_API_KEY=<your-x-api-key-or-leave-blank-if-not-enforced>
```

For local dev against `localhost:8000`, use `VITE_API_URL=/api/v1` and proxy
in `vite.config.ts`:

```ts
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api/v1': 'http://localhost:8000',
    },
  },
});
```

## Mount the App

Make sure your `src/main.tsx` looks roughly like this. Notably:
- Import `./index.css` for the theme tokens to apply
- No StrictMode wrapper for now (optional; add back if you want)

```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
```

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Build-time API base URL: set VITE_API_URL when building for deployment,
// e.g. VITE_API_URL=https://exam-api.onrender.com/api npm run build
// (no /v1 — the API mounts routes at /api). Local default is the Vite
// dev server's backend on http://localhost:5000/api.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
  },
});

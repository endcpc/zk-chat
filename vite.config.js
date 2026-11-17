import { defineConfig } from 'vite';

export default defineConfig({
  root: 'client',
  publicDir: 'public',
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
    assetsInlineLimit: 0, // keep CSP strict: no data: scripts or styles
  },
  server: {
    // `npm run dev` serves the client on :5173 and proxies the relay to `wrangler dev` on :8787
    proxy: { '/ws': { target: 'http://127.0.0.1:8787', ws: true } },
  },
});

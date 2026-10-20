import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

/** Frontend Vite config for the Tauri v2 shell; `src/` is the frontend root. */
export default defineConfig({
  root: resolve(__dirname, 'src'),
  plugins: [vue()],
  // Tauri owns the terminal; keep Vite from clearing its build output.
  clearScreen: false,
  envPrefix: ['VITE_', 'TAURI_ENV_'],
  // `jsavvy` is a UMD bundle that references the bare `global` identifier. Rollup
  // rewrites it in a production build, but Vite's dev dep pre-bundler leaves it
  // alone, so `.sav` import throws "global is not defined" only under `vite dev`.
  define: { global: 'globalThis' },
  server: {
    port: 1420,
    strictPort: true,
    // src-tauri changes are Rust-side; watching them only causes reload storms.
    watch: { ignored: ['**/src-tauri/**'] }
  },
  build: {
    outDir: resolve(__dirname, 'dist'),
    emptyOutDir: true,
    target: 'chrome110',
    // Desktop WebView loads assets from disk; single vendor chunks like
    // plotly.js-dist-min (~4.8 MB) and exceljs (~940 kB) are lazy-loaded on demand.
    chunkSizeWarningLimit: 5500
  }
})

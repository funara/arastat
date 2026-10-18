import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  main: {},
  // Sandboxed preload scripts must be CommonJS: force CJS output despite
  // "type": "module" (ESM preload cannot be sandboxed). The update preload
  // backs the strong-guidance update card window (see src/main/update-window.ts).
  preload: {
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts'),
          update: resolve(__dirname, 'src/preload/update.ts')
        },
        output: { format: 'cjs', entryFileNames: '[name].js' }
      }
    }
  },
  renderer: {
    plugins: [vue()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
          update: resolve(__dirname, 'src/renderer/update.html')
        }
      }
    }
  }
})

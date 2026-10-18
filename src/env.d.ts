// Global `window.ara` / `window.araUpdate` typing for the renderer.
//
// The shapes come from the contract in `shared/bridge-api.ts`, which
// `tauri-bridge.ts` implements and is type-checked against.
import type { AraApi, AraUpdateApi } from './shared/bridge-api.ts'

export {}

declare global {
  interface Window {
    ara: AraApi
    araUpdate: AraUpdateApi
  }
}

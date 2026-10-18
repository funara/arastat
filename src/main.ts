// The Tauri bridge must be installed before any component reads window.ara.
import { installTauriBridge } from './tauri-bridge.ts'

import { createApp } from 'vue'
import App from './App.vue'
import './ara.css'

installTauriBridge()

createApp(App).mount('#app')

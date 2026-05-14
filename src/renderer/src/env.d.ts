/// <reference types="vite/client" />

import type { ElectronAPI } from '@electron-toolkit/preload'
import type { AppApi } from '../../preload/index'

declare global {
  interface Window {
    api: AppApi
    electron: ElectronAPI
  }
}

export {}

import { defineStore } from 'pinia'
import type { MascotStatus } from '../types/mascot'

interface MascotState {
  status: MascotStatus
  panelVisible: boolean
  alwaysOnTop: boolean
  message: string
}

let resetTimer: number | undefined

export const useMascotStore = defineStore('mascot', {
  state: (): MascotState => ({
    status: 'idle',
    panelVisible: false,
    alwaysOnTop: true,
    message: ''
  }),
  actions: {
    setStatus(status: MascotStatus) {
      this.status = status
    },
    togglePanel() {
      this.panelVisible = !this.panelVisible
    },
    showPanel() {
      this.panelVisible = true
    },
    hidePanel() {
      this.panelVisible = false
    },
    showMessage(message: string, status?: MascotStatus, autoReset = false) {
      this.message = message
      if (status) this.status = status
      window.clearTimeout(resetTimer)
      if (autoReset) {
        resetTimer = window.setTimeout(() => {
          this.status = 'idle'
          this.message = ''
        }, 2200)
      }
    },
    resetStatus() {
      this.status = 'idle'
      this.message = ''
    }
  }
})

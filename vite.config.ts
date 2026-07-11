import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const smartTodoApiTarget = env.VITE_API_BASE_URL || 'http://192.168.0.210:8066'

  return {
    plugins: [vue()],
    clearScreen: false,
    server: {
      host: '127.0.0.1',
      port: 1420,
      strictPort: true,
      proxy: {
        '/login': {
          target: smartTodoApiTarget,
          changeOrigin: true
        },
        '/getInfo': {
          target: smartTodoApiTarget,
          changeOrigin: true
        },
        '/logout': {
          target: smartTodoApiTarget,
          changeOrigin: true
        },
        '/smart-todo': {
          target: smartTodoApiTarget,
          changeOrigin: true
        },
        '/sys-message': {
          target: smartTodoApiTarget,
          changeOrigin: true
        },
        '/websocket': {
          target: smartTodoApiTarget,
          changeOrigin: true,
          ws: true
        }
      }
    },
    envPrefix: ['VITE_']
  }
})

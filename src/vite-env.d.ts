/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_APP_NAME: string
  readonly VITE_API_BASE_URL: string
  readonly VITE_WEB_BASE_URL: string
  readonly VITE_WS_URL: string
  readonly VITE_ENABLE_MOCK: string
  readonly VITE_MOCK_USER_ID?: string
  readonly VITE_MOCK_TOKEN?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

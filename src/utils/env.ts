export const env = {
  appName: import.meta.env.VITE_APP_NAME || '华力AI桌面助手',
  apiBaseUrl: import.meta.env.VITE_API_BASE_URL || 'http://127.0.0.1:8080/api',
  webBaseUrl: import.meta.env.VITE_WEB_BASE_URL || 'http://127.0.0.1:5173',
  wsUrl: import.meta.env.VITE_WS_URL || 'ws://127.0.0.1:8080/ws/desktop',
  enableMock: import.meta.env.VITE_ENABLE_MOCK !== 'false',
  useMockApi: import.meta.env.VITE_USE_MOCK_API === 'true',
  mockUserId: import.meta.env.VITE_MOCK_USER_ID || 'u001',
  mockToken: import.meta.env.VITE_MOCK_TOKEN || 'mock_desktop_token'
}

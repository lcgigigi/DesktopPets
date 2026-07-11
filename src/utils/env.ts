const webBaseUrl = import.meta.env.VITE_WEB_BASE_URL || 'http://127.0.0.1:5173'
const enableMock = import.meta.env.VITE_ENABLE_MOCK !== 'false'

export const env = {
  buildMode: import.meta.env.MODE,
  appName: import.meta.env.VITE_APP_NAME || '华力AI桌面助手',
  apiBaseUrl: import.meta.env.VITE_API_BASE_URL || '',
  webBaseUrl,
  wsUrl: import.meta.env.VITE_WS_URL || '',
  sysMessageWsBaseUrl: import.meta.env.VITE_SYS_MESSAGE_WS_BASE_URL || '',
  desktopUserId: import.meta.env.VITE_DESKTOP_USER_ID || '',
  enableMock,
  useMockApi: import.meta.env.VITE_USE_MOCK_API === 'true',
  mockUserId: import.meta.env.VITE_MOCK_USER_ID || (enableMock ? 'u001' : ''),
  mockToken: import.meta.env.VITE_MOCK_TOKEN || (enableMock ? 'mock_desktop_token' : '')
}

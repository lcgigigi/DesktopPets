export function formatDateTime(value?: string) {
  if (!value) return '未设置'
  const normalized = value.replace('T', ' ').slice(0, 16)
  return normalized || value
}

export function nowTimestamp() {
  const now = new Date()
  const pad = (part: number) => String(part).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(
    now.getHours()
  )}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
}


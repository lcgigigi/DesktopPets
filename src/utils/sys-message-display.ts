export function formatSysMessageDisplayTime(rawValue?: string, now = new Date()) {
  const raw = rawValue?.trim()
  if (!raw) return '刚刚'

  const parsed = new Date(raw.replace(' ', 'T'))
  if (Number.isNaN(parsed.getTime())) return raw.slice(0, 16)

  const time = new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).format(parsed)
  const isToday = parsed.getFullYear() === now.getFullYear()
    && parsed.getMonth() === now.getMonth()
    && parsed.getDate() === now.getDate()

  if (isToday) return `今天 ${time}`
  return `${parsed.getMonth() + 1}月${parsed.getDate()}日 ${time}`
}

export function normalizeSysMessageDateTime(rawValue?: string) {
  const raw = rawValue?.trim()
  if (!raw) return undefined

  const normalized = raw.replace(' ', 'T')
  return Number.isNaN(new Date(normalized).getTime()) ? undefined : normalized
}

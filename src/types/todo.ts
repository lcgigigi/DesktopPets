export interface TodoParseRequest {
  source: 'desktop-mascot'
  inputType: 'text' | 'voice'
  text: string
  userId?: string
}

export interface TodoParseResult {
  title: string
  date: string
  endDate?: string
  time?: string
  assigneeId?: string
  assigneeName?: string
  source?: string
}

export interface TodoParseResponse {
  confidence: number
  draftId: string
  needConfirm: boolean
  result: TodoParseResult
}

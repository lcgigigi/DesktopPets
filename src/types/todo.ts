export interface TodoParseRequest {
  source: 'desktop-mascot'
  inputType: 'text'
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

export interface SmartTodoMain {
  id?: number
  title?: string
  content?: string
  remark?: string
  otherContent?: string | null
  completeDesc?: string | null
  assigneeIds?: string | null
  assigneeNickName?: string | null
  handlerId?: string | null
  handlerNickName?: string | null
  creatorId?: string | null
  creatorNickName?: string | null
  startDateShow?: string | null
  endDateShow?: string | null
  startDate?: string | null
  endDate?: string | null
}

export interface SmartTodoDetailResponse {
  mainTodo?: SmartTodoMain
}

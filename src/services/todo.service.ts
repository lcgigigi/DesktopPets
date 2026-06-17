import { request } from './request'
import { mockParseTodo } from './mock.service'
import type { TodoParseResponse } from '../types/todo'
import { env } from '../utils/env'

export async function parseTodo(text: string): Promise<TodoParseResponse> {
  if (env.enableMock && !env.useMockApi) {
    return mockParseTodo(text)
  }

  return request.post('/ai/todo/parse', {
    source: 'desktop-mascot',
    inputType: 'text',
    text,
    userId: env.mockUserId
  })
}

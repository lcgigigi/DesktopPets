import type { TaskAction, TaskCreatedPayload } from '../types/task'

export interface VisibleTaskAction {
  key: Extract<TaskAction, 'confirm' | 'openDetail'>
  label: string
}

const COMPLETE_ACTION: VisibleTaskAction = { key: 'confirm', label: '完成' }
const VIEW_ACTION: VisibleTaskAction = { key: 'openDetail', label: '查看详情' }

/**
 * Desktop cards only expose actions that are both implemented and safe here.
 * Legacy task payloads without an action list retain the connected completion
 * action. A read-only detail link is always available, while destructive or
 * unpersisted actions (cancel/later) are never inferred from arbitrary labels.
 */
export function getVisibleTaskActions(
  actions?: TaskCreatedPayload['actions']
): VisibleTaskAction[] {
  const hasExplicitActions = Array.isArray(actions) && actions.length > 0
  const canComplete = !hasExplicitActions || actions.some((action) => action.key === 'confirm')

  return canComplete ? [COMPLETE_ACTION, VIEW_ACTION] : [VIEW_ACTION]
}

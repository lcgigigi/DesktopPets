import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import appSource from '../App.vue?raw'
import taskCardSource from '../components/TaskPushCard.vue?raw'
import todoInputSource from '../components/TodoInputBox.vue?raw'
import sysMessageServiceSource from '../services/sys-message.service.ts?raw'
import windowServiceSource from '../services/window.service.ts?raw'
import taskStoreSource from '../stores/task.ts?raw'
import mascotWindowSource from '../views/MascotWindow.vue?raw'
import panelSource from '../views/PanelWindow.vue?raw'
import rustSource from '../../src-tauri/src/main.rs?raw'

const appStyles = readFileSync(new URL('../assets/styles/app.css', import.meta.url), 'utf8')

function section(source: string, startMarker: string, endMarker: string) {
  const start = source.indexOf(startMarker)
  const end = source.indexOf(endMarker, start + startMarker.length)
  expect(start, `missing section start: ${startMarker}`).toBeGreaterThanOrEqual(0)
  expect(end, `missing section end: ${endMarker}`).toBeGreaterThan(start)
  return source.slice(start, end)
}

function normalize(source: string) {
  return source.replace(/\s+/g, ' ').trim()
}

function expectInOrder(source: string, ...fragments: string[]) {
  const normalizedSource = normalize(source)
  let cursor = 0
  for (const fragment of fragments) {
    const normalizedFragment = normalize(fragment)
    const index = normalizedSource.indexOf(normalizedFragment, cursor)
    expect(index, `missing or out-of-order contract fragment: ${normalizedFragment}`).toBeGreaterThanOrEqual(cursor)
    cursor = index + normalizedFragment.length
  }
}

describe('notification and task production contracts', () => {
  it('stores a panel task and returns the matching eventId ACK before requesting reveal', () => {
    const panelDeliveryListener = section(
      appSource,
      "removePanelTaskListener = await listen<PanelTaskDeliveryPayload>('task-created'",
      'removePanelTaskStateRequestListener = await listen<PanelTaskStateRequestPayload>',
    )

    expectInOrder(
      panelDeliveryListener,
      'if (panelSessionEpoch.value !== delivery.sessionEpoch) return',
      'taskStore.pushTask(delivery.event)',
      'eventId: delivery.event.eventId',
      'sessionEpoch: delivery.sessionEpoch',
      "await emitTo('mascot', PANEL_TASK_DELIVERED_EVENT, ack)",
      'publishPanelTaskState(true)',
    )
    expect(panelSource).toContain('<TaskPushCard')
    expect(panelSource).toContain('v-if="task"')
    expect(panelSource).toContain('<TodoInputBox')
    expect(panelSource).toContain('v-else')
  })

  it('keeps the queue head until a matching eventId and sessionEpoch ACK arrives', () => {
    const delivery = section(
      appSource,
      'async function deliverTasksWhenSystemMessagesFinish()',
      'function handleTaskDelivered',
    )
    const acknowledge = section(
      appSource,
      'function handleTaskDelivered',
      'function requestPanelTaskState',
    )

    expectInOrder(
      delivery,
      'const event = deferredTaskEvents[0]',
      'awaitingTaskDelivery = {',
      'eventId: event.eventId',
      'sessionEpoch: taskSessionEpoch',
      "await emitTo('panel', 'task-created', delivery)",
      'window.setTimeout',
      'awaitingTaskDelivery = null',
      'void deliverTasksWhenSystemMessagesFinish()',
    )
    expect(delivery).not.toContain('deferredTaskEvents.shift()')
    expectInOrder(
      acknowledge,
      'payload.sessionEpoch !== taskSessionEpoch',
      'awaitingTaskDelivery?.sessionEpoch !== payload.sessionEpoch',
      'awaitingTaskDelivery.eventId !== payload.eventId',
      'deferredTaskEvents[0]?.eventId !== payload.eventId',
      'awaitingTaskDelivery = null',
      'deferredTaskEvents.shift()',
      'void deliverTasksWhenSystemMessagesFinish()',
    )
  })

  it('rejects stale sessions and does not deliver or reveal tasks while authentication is required', () => {
    const delivery = section(
      appSource,
      'async function deliverTasksWhenSystemMessagesFinish()',
      'function handleTaskDelivered',
    )
    const reveal = section(appSource, 'async function showTaskPanelWithFallback()', 'function queueTaskForPanel')
    const panelState = section(appSource, 'function handlePanelTaskState', 'watch(currentTask')
    const panelEpoch = section(appSource, 'function adoptPanelSessionEpoch', 'async function showTaskPanelWithFallback')
    const taskPushListener = section(
      appSource,
      'removeTaskListener = websocketService.onTask',
      'removeStatusListener = websocketService.onStatus',
    )

    expect(delivery).toContain('needsAuth.value')
    expect(delivery).toContain('!panelTaskStateReady.value')
    expect(reveal).toContain('needsAuth.value')
    expect(reveal).toContain('currentSysMessage.value')
    expect(panelState).toContain('payload.sessionEpoch !== taskSessionEpoch')
    expect(panelState).toContain('void deliverTasksWhenSystemMessagesFinish()')
    expect(panelEpoch).toContain('sessionEpoch < panelSessionEpoch.value')
    expect(panelEpoch).toContain('taskStore.clearTasks()')
    expect(taskPushListener).toContain('if (needsAuth.value) return')
  })

  it('uses one coordinator as the sole task-panel reveal authority', () => {
    const delivery = section(
      appSource,
      'async function deliverTasksWhenSystemMessagesFinish()',
      'function handleTaskDelivered',
    )
    const panelState = section(appSource, 'function handlePanelTaskState', 'watch(currentTask')

    expect(delivery).toContain('await showTaskPanelWithFallback()')
    expect(panelState).toContain('void deliverTasksWhenSystemMessagesFinish()')
    expect(panelState).not.toContain('showTaskPanelWithFallback()')
    // One definition plus one coordinator-owned call. A second call site can
    // race the ACK/state callback and reveal/animate the same panel twice.
    expect(appSource.match(/showTaskPanelWithFallback\(\)/g)).toHaveLength(2)
  })

  it('keeps panel failures inline and prevents a competing mascot bubble', () => {
    const taskAction = section(taskStoreSource, 'async handleAction', '\n    }\n  }')
    const panelTaskAction = section(panelSource, 'async function handleTaskAction', '</script>')
    const todoSubmit = section(panelSource, 'async function submitTodo', 'async function handleTaskAction')
    const mascotTemplate = section(mascotWindowSource, '<template>', '</template>')

    expectInOrder(taskAction, 'catch (error)', 'task.error =', 'return false', 'finally')
    expect(taskCardSource).toContain('v-if="task.error"')
    expect(taskCardSource).toContain('class="task-card__error" role="alert"')
    expect(panelTaskAction).not.toContain('showMascotMessage(')
    expectInOrder(todoSubmit, 'if (!opened)', 'submitError.value =', 'return')
    expect(todoInputSource).toContain('class="todo-input__error"')
    expect(todoInputSource).toContain('role="alert"')

    // Auth, system message and bubble share one out-in branch, so they cannot
    // render in parallel inside the mascot's expanded transparent HWND.
    expect(mascotTemplate).toContain('mode="out-in"')
    expectInOrder(mascotTemplate, 'v-if="!isContextMenuVisible && needsAuth"', 'v-else-if="!isContextMenuVisible && sysMessage"', 'v-else-if="!isContextMenuVisible && mascotStore.message"')
    expect(mascotWindowSource).not.toMatch(/watch\(\s*hasBubbleMessage\s*,[\s\S]{0,260}?hidePanelWindow\(\)/)
  })

  it('wakes a hidden assistant without activation for bubbles, system cards and pushed tasks', () => {
    const notificationReveal = section(
      mascotWindowSource,
      'async function revealNotificationAfterLayout',
      'function scheduleIdleHide',
    )
    const taskReveal = section(appSource, 'async function showTaskPanelWithFallback()', 'function queueTaskForPanel')
    const nativeNotification = section(rustSource, 'fn show_notification_window', '#[tauri::command]\nfn peek_mascot_window')
    const nativePanel = section(rustSource, 'fn show_panel_window', '#[tauri::command]\nfn hide_panel_window')

    expect(notificationReveal).toContain('force: visible || attempt > 0')
    expect(notificationReveal).toContain('shown = await showNotificationWindow()')
    expect(taskReveal).not.toContain('showNotificationWindow()')
    expect(taskReveal).toContain('await showPanelWindow({ focus: false })')
    expect(nativeNotification).toContain('show_window_without_activation(&window)')
    expectInOrder(nativePanel, 'restore_mascot_if_peeked', 'place_panel_near_mascot', 'show_window_without_activation(&mascot)', 'show_window_without_activation(&panel)')
    expect(nativePanel).toContain('show_window_without_activation(&mascot)')
    expect(nativePanel).toContain('show_window_without_activation(&panel)')
  })

  it('shows a notification only after bounds succeed and retries the full pipeline once', () => {
    const syncLayout = section(
      mascotWindowSource,
      'async function syncNativeNotificationLayout',
      'function notificationLayoutStillDesired',
    )
    const reveal = section(
      mascotWindowSource,
      'async function revealNotificationAfterLayout',
      'function scheduleIdleHide',
    )

    expectInOrder(syncLayout, 'const synced = await setMascotNotificationVisible', 'if (synced)', 'nativeNotificationLayout = { visible, compact }')
    expectInOrder(reveal, 'const synced = await syncNativeNotificationLayout', 'if (synced && visible && notificationCoordinatorReady)', 'shown = await showNotificationWindow()', 'if (synced && shown) return', 'if (attempt >= 1) return', 'attempt + 1')
    expect(reveal.match(/showNotificationWindow\(\)/g)).toHaveLength(1)
    expect(mascotWindowSource).toContain("{ immediate: true, flush: 'post' }")
    expect(rustSource).toMatch(/fn set_window_bounds[\s\S]{0,220}?Result<\(\), String>/)
    expect(rustSource).toMatch(/fn resize_mascot_for_notification[\s\S]{0,320}?Result<\(\), String>/)
    expect(rustSource).toMatch(/fn set_mascot_notification_visible[\s\S]{0,620}?-> bool/)
  })

  it('clears queued delivery state and invalidates old panel events on session clear', () => {
    const clearSession = section(appSource, 'function clearDesktopSession', 'function handleSessionExpired')
    const panelClearListener = section(
      appSource,
      "removePanelSessionClearedListener = await listen<PanelTaskStateRequestPayload>",
      "void emitTo('mascot', PANEL_TASK_READY_EVENT",
    )

    expectInOrder(
      clearSession,
      'taskSessionEpoch += 1',
      'window.clearTimeout(taskDeliveryRetryTimer)',
      'awaitingTaskDelivery = null',
      'deferredTaskEvents.length = 0',
      'panelTaskStateReady.value = false',
      'panelHasTask.value = false',
      "emitTo('panel', 'desktop-session-cleared', { sessionEpoch: taskSessionEpoch })",
    )
    expectInOrder(panelClearListener, 'adoptPanelSessionEpoch(event.payload.sessionEpoch)', 'taskStore.clearTasks()', 'publishPanelTaskState()')
  })

  it('uses safe focus defaults and focuses the task card only after explicit user activation', () => {
    const showPanel = section(windowServiceSource, 'export async function showPanelWindow', 'export async function hidePanelWindow')
    const panelReveal = section(panelSource, 'function playPanelReveal', 'onMounted')
    const nativePanel = section(rustSource, 'fn show_panel_window', '#[tauri::command]\nfn hide_panel_window')
    const nativeToggle = section(rustSource, 'fn toggle_panel_window', '#[tauri::command]\nfn show_panel_window')

    expect(showPanel).toContain('focus: options.focus ?? false')
    expect(showPanel).toContain('if (visible)')
    expect(panelReveal).toContain('if (options.focus)')
    expect(panelReveal).toContain('window.setTimeout(focusVisibleControl, 80)')
    expect(nativePanel).toContain('let should_focus = focus.unwrap_or(false)')
    expect(nativePanel).toContain('show_window_without_activation(&panel)')
    expect(nativeToggle).toContain('panel.set_focus()')
    expect(taskCardSource).toContain('tabindex="-1"')
    expect(taskCardSource).not.toContain('autofocus')
  })

  it('treats markRead data false as failure and keeps the system card visible', () => {
    const markRead = section(sysMessageServiceSource, 'async markRead', 'disconnect()')
    const readHandler = section(appSource, 'async function handleSysMessageRead', 'async function handleSysMessageView')
    const viewHandler = section(appSource, 'async function handleSysMessageView', 'function connectDesktopSockets')

    expectInOrder(markRead, 'const markedRead = await request.put', "if (markedRead !== true) throw new Error('服务端未确认消息已读')", 'message.msgStatus = 1')
    expectInOrder(readHandler, 'await sysMessageService.markRead(message)', 'hideCurrentSysMessage(message)', 'catch (error)', "sysMessageActionError.value = '未能标记已读，请检查网络后重试'")
    expectInOrder(viewHandler, 'const opened = await openSysMessageDetail(message)', 'if (!opened)', 'await sysMessageService.markRead(message)', 'catch (error)', 'return', 'hideCurrentSysMessage(message)')
  })

  it('renders message fallback immediately and enriches each message independently', () => {
    const pushHandler = section(appSource, 'function pushSysMessage', 'function hideCurrentSysMessage')

    expectInOrder(pushHandler, 'showIncomingSysMessage', 'getSysMessageFallback(message)', 'void enrichSysMessage(message, generation)')
    expect(appSource).not.toContain('sysMessageResolutionQueue')
    expect(appSource).not.toContain('isResolvingSysMessage')
  })

  it('keeps unsupported task actions out and failed workbench drafts retryable', () => {
    const submitHandler = section(panelSource, 'async function submitTodo', 'async function handleTaskAction')

    expect(taskCardSource).not.toContain("'later'")
    expect(taskCardSource).not.toContain('16:00')
    expect(taskCardSource).not.toContain('确认会议纪要')
    expect(taskCardSource).toContain('getVisibleTaskActions')
    expectInOrder(submitHandler, 'if (!opened)', 'return', 'inputBoxRef.value?.clear()', 'hidePanelWindow()')
    expect(todoInputSource).toContain('<label class="sr-only"')
    expect(appStyles).toMatch(/\.pet-prompt \.todo-input:focus-within\s*\{[\s\S]*?box-shadow:/)
  })

  it('keeps variable notification text scrollable with production-sized action targets', () => {
    expect(appStyles).toMatch(/\.sys-message-tip__body h2\s*\{[\s\S]*?overflow-y: auto;/)
    expect(appStyles).toMatch(/\.sys-message-tip__error\s*\{[\s\S]*?overflow-y: auto;/)
    expect(appStyles).toMatch(/\.pet-prompt\.has-task \.task-card__action\s*\{[\s\S]*?min-height: 40px;/)
    expect(appStyles).toMatch(/@media \(max-height: 440px\)[\s\S]*?\.sys-message-tip__button\s*\{[\s\S]*?min-height: 40px;/)
  })

  it('provides deterministic DEV previews for long, queued and error states', () => {
    expect(appSource).toContain("searchParams.get('preview') === 'task'")
    expect(appSource).toContain("searchParams.get('previewQueue') === '1'")
    expect(appSource).toContain("searchParams.get('previewError') === '1'")
    expect(appSource).toContain("searchParams.get('previewLong') === '1'")
  })
})

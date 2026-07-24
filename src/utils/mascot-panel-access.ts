export function canOpenMascotTodoPanel(needsAuth: boolean, hasSystemMessage: boolean) {
  return !needsAuth && !hasSystemMessage
}

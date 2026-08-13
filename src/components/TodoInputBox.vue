<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { storage } from '../utils/storage'
import {
  clampTodoTextareaHeight,
  getTodoPanelHeight,
  TODO_TEXTAREA_MAX_HEIGHT,
  TODO_TEXTAREA_MIN_HEIGHT
} from '../utils/todo-input-layout'

const props = defineProps<{
  loading: boolean
  error?: string
}>()

const emit = defineEmits<{
  submit: [text: string]
  draftChange: [text: string]
  focusChange: [focused: boolean]
  heightChange: [height: number]
}>()

const text = ref(storage.getTodoInputDraft())
const inputRef = ref<HTMLTextAreaElement | null>(null)
const textareaHeight = ref(TODO_TEXTAREA_MIN_HEIGHT)
const canSubmit = computed(() => text.value.trim().length > 0 && !props.loading)
const isMultiline = computed(() => textareaHeight.value > TODO_TEXTAREA_MIN_HEIGHT)
let lastPanelHeight = 0

function submit() {
  const value = text.value.trim()
  if (!value || props.loading) return
  emit('submit', value)
}

function focus() {
  inputRef.value?.focus()
}

function syncHeight() {
  void nextTick(() => {
    const input = inputRef.value
    if (!input) return

    input.style.height = '0px'
    const height = clampTodoTextareaHeight(input.scrollHeight)
    textareaHeight.value = height
    input.style.height = `${height}px`
    input.style.overflowY = input.scrollHeight > TODO_TEXTAREA_MAX_HEIGHT ? 'auto' : 'hidden'
    const panelHeight = getTodoPanelHeight(height, Boolean(props.error))
    if (panelHeight !== lastPanelHeight) {
      lastPanelHeight = panelHeight
      emit('heightChange', panelHeight)
    }
  })
}

function handleInput() {
  storage.setTodoInputDraft(text.value)
  emit('draftChange', text.value)
  syncHeight()
}

function handleFocus() {
  emit('focusChange', true)
}

function handleBlur() {
  emit('focusChange', false)
}

function handleKeydown(event: KeyboardEvent) {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return
  event.preventDefault()
  submit()
}

function clear() {
  text.value = ''
  storage.setTodoInputDraft('')
  emit('draftChange', '')
  syncHeight()
}

function getDraft() {
  return text.value
}

onMounted(() => {
  emit('draftChange', text.value)
  syncHeight()
})

watch(() => props.error, syncHeight)

defineExpose({ clear, focus, getDraft, syncHeight })
</script>

<template>
  <form
    class="todo-input"
    :class="{ 'is-multiline': isMultiline, 'has-error': error }"
    :aria-busy="loading"
    @submit.prevent="submit"
  >
    <label class="sr-only" for="desktop-todo-input">输入要创建的待办、提醒或会议安排</label>
    <textarea
      id="desktop-todo-input"
      ref="inputRef"
      v-model="text"
      rows="1"
      placeholder="一句话创建待办、提醒或会议安排"
      :disabled="loading"
      :aria-describedby="error ? 'desktop-todo-input-error' : undefined"
      @input="handleInput"
      @focus="handleFocus"
      @blur="handleBlur"
      @keydown="handleKeydown"
    />
    <button class="todo-input__send" type="submit" :disabled="!canSubmit">
      <span class="sr-only">{{ loading ? '提交中' : '确认创建' }}</span>
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M21 3 10 14" />
        <path d="m21 3-7 18-4-7-7-4 18-7Z" />
      </svg>
    </button>
    <p
      v-if="error"
      id="desktop-todo-input-error"
      class="todo-input__error"
      role="alert"
      tabindex="0"
    >
      {{ error }} 可保留当前内容再次提交。
    </p>
  </form>
</template>

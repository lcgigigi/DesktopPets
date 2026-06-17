<script setup lang="ts">
import { computed, ref } from 'vue'

const props = defineProps<{
  loading: boolean
}>()

const emit = defineEmits<{
  submit: [text: string]
}>()

const text = ref('')
const inputRef = ref<HTMLInputElement | null>(null)
const listening = ref(false)
const canSubmit = computed(() => text.value.trim().length > 0 && !props.loading)
const placeholder = computed(() => (listening.value ? '正在听你说...' : '一句话创建待办、提醒或会议安排'))

function submit() {
  const value = text.value.trim()
  if (!value || props.loading) return
  emit('submit', value)
  text.value = ''
  listening.value = false
}

function toggleVoiceInput() {
  if (props.loading) return
  listening.value = !listening.value
  inputRef.value?.focus()
}

function focus() {
  inputRef.value?.focus()
}

defineExpose({ focus })
</script>

<template>
  <form class="todo-input" @submit.prevent="submit">
    <button
      class="todo-input__assist"
      :class="{ 'is-active': listening }"
      type="button"
      :aria-label="listening ? '关闭语音输入' : '语音输入'"
      :aria-pressed="listening"
      :disabled="loading"
      @click="toggleVoiceInput"
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Z" />
        <path d="M5 11a7 7 0 0 0 14 0" />
        <path d="M12 18v3" />
        <path d="M9 21h6" />
      </svg>
    </button>
    <span class="todo-input__divider" aria-hidden="true" />
    <input
      ref="inputRef"
      v-model="text"
      type="text"
      :placeholder="placeholder"
      :disabled="loading"
    />
    <button class="todo-input__send" type="submit" :disabled="!canSubmit">
      <span class="sr-only">{{ loading ? '识别中' : '确认创建' }}</span>
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M21 3 10 14" />
        <path d="m21 3-7 18-4-7-7-4 18-7Z" />
      </svg>
    </button>
  </form>
</template>

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
const canSubmit = computed(() => text.value.trim().length > 0 && !props.loading)

function submit() {
  const value = text.value.trim()
  if (!value || props.loading) return
  emit('submit', value)
  text.value = ''
}

function focus() {
  inputRef.value?.focus()
}

defineExpose({ focus })
</script>

<template>
  <form class="todo-input" @submit.prevent="submit">
    <input
      ref="inputRef"
      v-model="text"
      type="text"
      placeholder="一句话创建待办、提醒或会议安排"
      :disabled="loading"
    />
    <button class="todo-input__send" type="submit" :disabled="!canSubmit">
      <span class="sr-only">{{ loading ? '提交中' : '确认创建' }}</span>
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M21 3 10 14" />
        <path d="m21 3-7 18-4-7-7-4 18-7Z" />
      </svg>
    </button>
  </form>
</template>

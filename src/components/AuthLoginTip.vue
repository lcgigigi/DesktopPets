<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{
  pending: boolean
  message?: string
}>()

const emit = defineEmits<{
  login: []
}>()

const headline = computed(() => {
  if (props.pending) return '等待网页登录完成'
  if (props.message) return '登录未完成'
  return '登录后开启消息提醒'
})

const body = computed(() => {
  if (props.message) return props.message
  if (props.pending) return '登录页面已打开，请在浏览器完成登录；如果页面被关闭，可以重新打开。'
  return '当前还没有获取到你的 Web 登录身份。登录后会自动接收站内消息。'
})
</script>

<template>
  <article
    class="auth-login-tip"
    :class="{ 'is-pending': pending, 'has-error': message }"
    :aria-busy="pending"
    aria-live="polite"
    @pointerdown.stop
    @pointermove.stop
    @pointerup.stop
    @click.stop
  >
    <div class="auth-login-tip__body">
      <strong>{{ headline }}</strong>
      <p :role="message ? 'alert' : 'status'">{{ body }}</p>
    </div>
    <button class="auth-login-tip__button" type="button" @click.stop="emit('login')">
      {{ pending ? '重新打开登录页' : message ? '重试登录' : '去登录' }}
    </button>
  </article>
</template>

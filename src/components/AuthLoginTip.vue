<script setup lang="ts">
defineProps<{
  pending: boolean
}>()

const emit = defineEmits<{
  login: []
}>()
</script>

<template>
  <article
    class="auth-login-tip"
    aria-live="polite"
    @pointerdown.stop
    @pointermove.stop
    @pointerup.stop
    @click.stop
  >
    <div class="auth-login-tip__body">
      <strong>登录后开启消息提醒</strong>
      <p>当前还没有获取到你的 Web 登录身份，登录后会自动接收站内消息。</p>
    </div>
    <button class="auth-login-tip__button" type="button" @click.stop="emit('login')">
      {{ pending ? '重新打开' : '去登录' }}
    </button>
  </article>
</template>

<script setup lang="ts">
import { reactive } from 'vue'
import type { DesktopLoginCredentials } from '../types/auth'

defineProps<{
  pending: boolean
  message?: string
}>()

const emit = defineEmits<{
  login: [credentials: DesktopLoginCredentials]
}>()

const credentials = reactive<DesktopLoginCredentials>({
  username: '',
  password: '',
})

function submitLogin() {
  if (!credentials.username.trim() || !credentials.password) return

  emit('login', {
    username: credentials.username.trim(),
    password: credentials.password,
  })
}
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
    <form class="auth-login-tip__form" @submit.prevent="submitLogin">
      <div class="auth-login-tip__body">
        <strong>登录桌面助手</strong>
        <p>{{ message || '使用你的 Web 账号登录，登录成功后会自动接收站内消息。' }}</p>
      </div>
      <label class="auth-login-tip__field">
        <span>账号</span>
        <input
          v-model="credentials.username"
          name="username"
          type="text"
          autocomplete="username"
          placeholder="请输入账号"
          :disabled="pending"
        />
      </label>
      <label class="auth-login-tip__field">
        <span>密码</span>
        <input
          v-model="credentials.password"
          name="password"
          type="password"
          autocomplete="current-password"
          placeholder="请输入密码"
          :disabled="pending"
        />
      </label>
      <button
        class="auth-login-tip__button"
        type="submit"
        :disabled="pending || !credentials.username.trim() || !credentials.password"
      >
        {{ pending ? '正在登录…' : '登录桌面助手' }}
      </button>
    </form>
  </article>
</template>

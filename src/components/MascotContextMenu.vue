<script setup lang="ts">
defineProps<{
  x: number
  y: number
  showLogin: boolean
  showLogout: boolean
}>()

const emit = defineEmits<{
  login: []
  logout: []
  close: []
}>()

function handleLogin() {
  emit('login')
  emit('close')
}

function handleLogout() {
  emit('logout')
  emit('close')
}
</script>

<template>
  <nav
    class="mascot-context-menu"
    :style="{ left: `${x}px`, top: `${y}px` }"
    aria-label="吉祥物功能栏"
    @contextmenu.prevent
  >
    <button
      v-if="showLogin"
      class="mascot-context-menu__item"
      type="button"
      aria-label="去登录"
      @click.stop="handleLogin"
    >
      <svg class="mascot-context-menu__icon" viewBox="0 0 24 24" aria-hidden="true">
        <path
          d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4M10 17l5-5-5-5M15 12H3"
          fill="none"
          stroke="currentColor"
          stroke-linecap="round"
          stroke-linejoin="round"
          stroke-width="2"
        />
      </svg>
      <span>去登录</span>
    </button>
    <button
      v-if="showLogout"
      class="mascot-context-menu__item"
      type="button"
      aria-label="退出登录"
      @click.stop="handleLogout"
    >
      <svg class="mascot-context-menu__icon" viewBox="0 0 24 24" aria-hidden="true">
        <path
          d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"
          fill="none"
          stroke="currentColor"
          stroke-linecap="round"
          stroke-linejoin="round"
          stroke-width="2"
        />
      </svg>
      <span>退出登录</span>
    </button>
  </nav>
</template>

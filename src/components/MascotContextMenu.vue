<script setup lang="ts">
import { nextTick, onMounted, ref, watch } from 'vue'

const props = defineProps<{
  x: number
  y: number
  placement?: 'above' | 'below'
  tailX?: number
  entering?: boolean
}>()

const emit = defineEmits<{
  hide: []
  exit: []
}>()

const menu = ref<HTMLElement | null>(null)

function focusSafeAction() {
  void nextTick(() => menu.value?.querySelector<HTMLButtonElement>('button')?.focus())
}

function handleHide() {
  emit('hide')
}

function handleExit() {
  emit('exit')
}

function handleKeydown(event: KeyboardEvent) {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return

  const items = Array.from(
    menu.value?.querySelectorAll<HTMLButtonElement>('.mascot-context-menu__item') ?? []
  )
  if (!items.length) return

  event.preventDefault()
  const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement)
  const nextIndex = event.key === 'Home'
    ? 0
    : event.key === 'End'
      ? items.length - 1
      : event.key === 'ArrowLeft'
        ? (currentIndex - 1 + items.length) % items.length
        : (currentIndex + 1) % items.length
  items[nextIndex]?.focus()
}

onMounted(() => {
  focusSafeAction()
})

// The component mounts while its native window is still hidden. Refocus once
// native show/focus has ACKed so every opening reliably starts on “隐藏”.
watch(() => props.entering, (entering) => {
  if (entering) focusSafeAction()
})
</script>

<template>
  <nav
    ref="menu"
    class="mascot-context-menu"
    :class="[
      placement === 'below' ? 'is-below' : 'is-above',
      { 'is-entering': entering }
    ]"
    :style="{
      left: `${x}px`,
      top: `${y}px`,
      width: `calc(100% - ${x * 2}px)`,
      '--menu-tail-x': `clamp(18px, ${tailX ?? 96}px, calc(100% - 18px))`
    }"
    aria-label="机器人功能菜单"
    @contextmenu.prevent
    @keydown="handleKeydown"
  >
    <button
      class="mascot-context-menu__item"
      type="button"
      aria-label="隐藏机器人，新提醒到达时会自动显示"
      title="隐藏后，有新提醒时会自动显示"
      @click.stop="handleHide"
    >
      <svg class="mascot-context-menu__icon" viewBox="0 0 24 24" aria-hidden="true">
        <path
          d="M3 3l18 18M10.6 10.7a2 2 0 0 0 2.7 2.7M9.9 4.2A10.8 10.8 0 0 1 12 4c5.2 0 8.6 4.4 9.5 6.1a3.8 3.8 0 0 1 0 3.8 15 15 0 0 1-2.3 3M6.2 6.2A15 15 0 0 0 2.5 10a3.8 3.8 0 0 0 0 4C3.4 15.6 6.8 20 12 20a10 10 0 0 0 3.1-.5"
          fill="none"
          stroke="currentColor"
          stroke-linecap="round"
          stroke-linejoin="round"
          stroke-width="1.8"
        />
      </svg>
      <span>隐藏</span>
    </button>
    <button
      class="mascot-context-menu__item mascot-context-menu__item--danger"
      type="button"
      aria-label="退出程序"
      title="退出程序"
      @click.stop="handleExit"
    >
      <svg class="mascot-context-menu__icon" viewBox="0 0 24 24" aria-hidden="true">
        <path
          d="M12 2v10M5.9 5.9a8 8 0 1 0 12.2 0"
          fill="none"
          stroke="currentColor"
          stroke-linecap="round"
          stroke-linejoin="round"
          stroke-width="1.9"
        />
      </svg>
      <span>退出</span>
    </button>
  </nav>
</template>

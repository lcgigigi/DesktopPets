<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{
  status: string
  mock: boolean
}>()

const statusLabel = computed(() => {
  if (props.mock) return '模拟推送'
  if (props.status === 'connected') return '在线'
  if (props.status === 'connecting') return '连接中'
  if (props.status === 'reconnecting') return '重连中'
  return '离线'
})
</script>

<template>
  <div class="tray-status">
    <span :class="{ active: status === 'connected' || status === 'mock' }" />
    {{ statusLabel }}
  </div>
</template>

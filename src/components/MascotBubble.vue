<script setup lang="ts">
defineProps<{
  message: string
}>()
</script>

<template>
  <div class="mascot-bubble" data-tauri-drag-region>
    {{ message }}
  </div>
</template>


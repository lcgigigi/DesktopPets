<script setup lang="ts">
defineProps<{
  message: string
}>()
</script>

<template>
  <div class="mascot-bubble" role="status" aria-live="polite">
    <span class="mascot-bubble__glow" aria-hidden="true" />
    <p class="mascot-bubble__text">{{ message }}</p>
    <span class="mascot-bubble__tail" aria-hidden="true" />
  </div>
</template>

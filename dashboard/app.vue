<template>
  <NuxtLayout>
    <NuxtPage />
  </NuxtLayout>
</template>

<script setup lang="ts">
import { useConfig } from '~/composables/useConfig'

const { loadConfig } = useConfig()
onMounted(loadConfig)
</script>

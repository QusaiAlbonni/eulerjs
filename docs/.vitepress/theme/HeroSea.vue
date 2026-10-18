<script setup lang="ts">
// The hero's picture, live: the screenshot until the sea has drawn, then the sea itself. It stays
// a picture where motion is unwelcome or the browser can't draw the sea.
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { withBase } from 'vitepress';

const container = ref<HTMLElement>();
const shown = ref(false);
let stop: (() => void) | undefined;
let unmounted = false;

onMounted(async () => {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches || !container.value) return;
  try {
    const { startHeroSea } = await import('./heroSea.js');
    if (unmounted) return;
    const stopSea = await startHeroSea(
      container.value,
      () => (shown.value = true),
      () => (shown.value = false),
    );
    if (unmounted) stopSea();
    else stop = stopSea;
  } catch (error) {
    console.warn('The hero sea could not be drawn; showing its picture instead.', error);
  }
});

onBeforeUnmount(() => {
  unmounted = true;
  stop?.();
});
</script>

<template>
  <div class="hero-sea" :class="{ shown }">
    <img class="poster" :src="withBase('/thumbnails/ocean.jpg')" alt="A spectral sea to the horizon, with crates afloat on it" />
    <div ref="container" class="live" aria-hidden="true" />
  </div>
</template>

<style scoped>
.hero-sea {
  position: absolute;
  top: 50%;
  left: 50%;
  width: min(320px, 86vw);
  aspect-ratio: 16 / 9;
  transform: translate(-50%, -50%);
  overflow: hidden;
  border-radius: 18px;
  box-shadow: 0 30px 60px -24px rgb(0 0 0 / 0.5);
}
@media (min-width: 640px) {
  .hero-sea {
    width: 392px;
  }
}
@media (min-width: 960px) {
  .hero-sea {
    width: 520px;
  }
}
.poster,
.live {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}
.poster {
  object-fit: cover;
}
.live {
  opacity: 0;
  transition: opacity 0.8s ease;
}
.shown .live {
  opacity: 1;
}
.live :deep(canvas) {
  display: block;
  width: 100% !important;
  height: 100% !important;
}
</style>

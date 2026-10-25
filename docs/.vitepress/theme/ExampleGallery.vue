<script setup lang="ts">
import { computed } from 'vue';
import { withBase } from 'vitepress';
import { BASICS, GAMES, THREE_ADDONS, TOOLS } from '../examples.js';
import type { Example } from '../examples.js';

const props = defineProps<{ group: 'games' | 'basics' | 'three-addons' | 'tools' }>();
const examples = computed<Example[]>(() => ({ games: GAMES, basics: BASICS, 'three-addons': THREE_ADDONS, tools: TOOLS })[props.group]);
</script>

<template>
  <div class="gallery" :class="`gallery-${group}`">
    <article v-for="example in examples" :key="example.id" class="card">
      <a class="shot" :href="withBase(`/${example.path}`)" target="_blank" rel="noopener" :aria-label="`Open the ${example.title} example`">
        <img :src="withBase(`/thumbnails/${example.id}.jpg`)" :alt="`The ${example.title} example`" loading="lazy" />
        <span class="play" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="22" height="22"><path fill="currentColor" d="M8 5.5v13l11-6.5z" /></svg>
        </span>
        <span v-if="example.webgpu" class="badge" title="Drawn with three/webgpu's WebGPURenderer, which falls back to WebGL 2 by itself">WebGPU</span>
      </a>
      <div class="body">
        <header>
          <h3>{{ example.title }}</h3>
          <a class="code" :href="example.source" target="_blank" rel="noopener" :title="`The ${example.title} example's code on GitHub`" :aria-label="`The ${example.title} example's code on GitHub`">
            <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
              <path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M8 7 3 12l5 5M16 7l5 5-5 5M13.5 4l-3 16" />
            </svg>
          </a>
        </header>
        <p class="description">{{ example.description }}</p>
        <p v-if="example.controls" class="controls">{{ example.controls }}</p>
        <ul class="tags">
          <li v-for="tag in example.tags" :key="tag">{{ tag }}</li>
        </ul>
        <div class="actions">
          <a class="open" :href="withBase(`/${example.path}`)" target="_blank" rel="noopener">Open example →</a>
          <a class="source" :href="example.source" target="_blank" rel="noopener">View code</a>
        </div>
      </div>
    </article>
  </div>
</template>

<style scoped>
.gallery {
  display: grid;
  gap: 20px;
  margin: 24px 0 40px;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
}
.gallery-games {
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
}
.card {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--vp-c-divider);
  border-radius: 14px;
  overflow: hidden;
  background: var(--vp-c-bg-soft);
  transition:
    transform 0.2s ease,
    box-shadow 0.2s ease,
    border-color 0.2s ease;
}
.card:hover {
  transform: translateY(-3px);
  border-color: var(--vp-c-brand-2);
  box-shadow: 0 12px 32px -12px rgb(0 0 0 / 0.35);
}
.shot {
  position: relative;
  display: block;
  aspect-ratio: 16 / 9;
  background: linear-gradient(135deg, #0b2a3d, #1f6582);
  overflow: hidden;
}
.shot img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  transition: transform 0.4s ease;
}
.card:hover .shot img {
  transform: scale(1.04);
}
.play {
  position: absolute;
  inset: 50% auto auto 50%;
  display: grid;
  place-items: center;
  width: 52px;
  height: 52px;
  margin: -26px 0 0 -26px;
  border-radius: 50%;
  color: #fff;
  background: rgb(0 0 0 / 0.45);
  backdrop-filter: blur(6px);
  opacity: 0;
  transition: opacity 0.2s ease;
}
.card:hover .play {
  opacity: 1;
}
.badge {
  position: absolute;
  top: 10px;
  left: 10px;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.02em;
  color: #fff;
  background: rgb(47 127 216 / 0.9);
}
.body {
  display: flex;
  flex: 1;
  flex-direction: column;
  padding: 14px 16px 16px;
}
header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
h3 {
  margin: 0;
  font-size: 17px;
  font-weight: 600;
  border: 0;
  padding: 0;
}
.code {
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  border-radius: 8px;
  color: var(--vp-c-text-2);
  border: 1px solid var(--vp-c-divider);
  transition:
    color 0.2s ease,
    border-color 0.2s ease,
    background 0.2s ease;
}
.code:hover {
  color: var(--vp-c-brand-1);
  border-color: var(--vp-c-brand-1);
  background: var(--vp-c-brand-soft);
}
.description {
  margin: 8px 0 0;
  font-size: 14px;
  line-height: 1.55;
  color: var(--vp-c-text-2);
}
.controls {
  margin: 8px 0 0;
  font-size: 12.5px;
  font-family: var(--vp-font-family-mono);
  color: var(--vp-c-text-3);
}
.tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 12px 0 0;
  padding: 0;
  list-style: none;
}
.tags li {
  margin: 0;
  padding: 1px 8px;
  border-radius: 6px;
  font-size: 12px;
  color: var(--vp-c-brand-1);
  background: var(--vp-c-brand-soft);
}
.actions {
  display: flex;
  gap: 16px;
  margin-top: auto;
  padding-top: 14px;
  font-size: 14px;
  font-weight: 500;
}
.actions a {
  text-decoration: none;
}
.source {
  color: var(--vp-c-text-2);
}
</style>

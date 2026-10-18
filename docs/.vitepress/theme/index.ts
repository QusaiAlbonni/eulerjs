import { h } from 'vue';
import DefaultTheme from 'vitepress/theme';
import type { Theme } from 'vitepress';
import ExampleGallery from './ExampleGallery.vue';
import HeroSea from './HeroSea.vue';
import './custom.css';

export default {
  extends: DefaultTheme,
  // the landing page's picture is the sea itself, live
  Layout: () => h(DefaultTheme.Layout, null, { 'home-hero-image': () => h(HeroSea) }),
  enhanceApp({ app }) {
    app.component('ExampleGallery', ExampleGallery);
  },
} satisfies Theme;

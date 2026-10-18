---
title: Examples
aside: false
pageClass: examples-page
---

# Examples

Every example runs in your browser, here, and its code is a click away: press the
<span class="inline-icon">&lt;/&gt;</span> on a card to read it on GitHub. Each one is its own small
Vite app in [`examples/`](https://github.com/QusaiAlbonni/eulerjs/tree/main/examples), run against
the engine's sources, so you can clone the repository and start any of them with one command.

::: tip Running them yourself
```sh
git clone https://github.com/QusaiAlbonni/eulerjs.git
cd eulerjs
npm install
npm run dev          # the sailboat
npm run dev:city     # the city
npm run dev:wedding  # the wedding
npm run dev:ocean    # the spectral ocean
npm run dev:basics   # the short examples
```
:::

## Games

Complete games built only on the public API: what the engine is for.

<ExampleGallery group="games" />

## Basics

Short examples, one idea each, in plain three.js.

<ExampleGallery group="basics" />

## Tools

Pages that measure rather than show: checks of the GPU's waves and benchmarks.

<ExampleGallery group="tools" />

::: info WebGPU
The examples marked WebGPU draw with three's `WebGPURenderer`, which uses WebGPU where the browser
has it and falls back to WebGL 2 by itself where it doesn't: they run in any current browser.
:::

<style>
.inline-icon {
  font-family: var(--vp-font-family-mono);
  font-size: 0.85em;
  padding: 1px 6px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 6px;
}
</style>

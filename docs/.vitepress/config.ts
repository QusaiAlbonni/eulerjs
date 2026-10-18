import { cpSync, existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitepress';
import type { DefaultTheme } from 'vitepress';
import { BASICS, GAMES, REPOSITORY, TOOLS } from './examples.js';
import { serveExamples } from './serveExamples.js';

// The site lives at https://qusaialbonni.github.io/eulerjs/; SITE_BASE overrides it, for a fork or a custom domain.
const base = process.env.SITE_BASE ?? '/eulerjs/';

// the examples, built by scripts/build-examples.mjs
const builtExamples = fileURLToPath(new URL('./built-examples', import.meta.url));

const sourceOf = (packageDirectory: string, entry = 'index') =>
  fileURLToPath(new URL(`../../packages/${packageDirectory}/src/${entry}.ts`, import.meta.url));

/** TypeDoc's sidebar for the API reference, once `npm run docs:api` has generated it. */
function apiSidebar(): DefaultTheme.SidebarItem[] {
  const path = fileURLToPath(new URL('../api/typedoc-sidebar.json', import.meta.url));
  if (!existsSync(path)) return [{ text: 'Run npm run docs:api to generate', link: '/api/' }];
  const items = JSON.parse(readFileSync(path, 'utf8')) as DefaultTheme.SidebarItem[];
  // the engine first, then its plugins
  return items.sort((first, second) => Number(first.text?.startsWith('@')) - Number(second.text?.startsWith('@')));
}

const guide: DefaultTheme.SidebarItem[] = [
  {
    text: 'Introduction',
    items: [
      { text: 'What is eulerjs?', link: '/guide/introduction' },
      { text: 'Getting started', link: '/guide/getting-started' },
    ],
  },
  {
    text: 'The engine',
    items: [
      { text: 'Bodies', link: '/guide/bodies' },
      { text: 'Colliders', link: '/guide/colliders' },
      { text: 'Joints', link: '/guide/joints' },
      { text: 'Scene queries and sensors', link: '/guide/queries' },
      { text: 'Instancing', link: '/guide/instancing' },
      { text: 'Solvers and backends', link: '/guide/solvers' },
      { text: 'Extending', link: '/guide/extending' },
      { text: 'Performance', link: '/guide/performance' },
    ],
  },
];

const plugins: DefaultTheme.SidebarItem[] = [
  {
    text: '@eulerjs/marine',
    items: [
      { text: 'Overview', link: '/marine/' },
      { text: 'The spectral sea', link: '/marine/spectral-sea' },
      { text: 'Drawing the water', link: '/marine/water-rendering' },
      { text: 'Buoyancy', link: '/marine/buoyancy' },
      { text: 'Sails and foils', link: '/marine/sails-and-foils' },
    ],
  },
  { text: '@eulerjs/vehicle', items: [{ text: 'Ray-cast vehicles', link: '/vehicle' }] },
  { text: '@eulerjs/bvh', items: [{ text: 'Triangle meshes', link: '/bvh' }] },
];

export default defineConfig({
  base,
  title: 'eulerjs',
  description: 'Rigid-body physics for three.js: accurate, fast, and three.js through and through.',
  lang: 'en-GB',
  cleanUrls: true,
  lastUpdated: true,
  head: [
    ['link', { rel: 'icon', type: 'image/png', href: `${base}favicon.png` }],
    ['meta', { name: 'theme-color', content: '#2f7fd8' }],
    ['meta', { property: 'og:title', content: 'eulerjs' }],
    ['meta', { property: 'og:description', content: 'Rigid-body physics for three.js' }],
    ['meta', { property: 'og:image', content: `${base}thumbnails/ocean.jpg` }],
  ],
  // the examples are separate Vite apps, copied into the built site under /examples/
  ignoreDeadLinks: [/^\/examples\/.+\//, /^\/examples\/.+\.html/],
  buildEnd: ({ outDir }) => {
    if (existsSync(builtExamples)) cpSync(builtExamples, `${outDir}/examples`, { recursive: true });
    else console.warn('The examples are not built, so the site has none: run npm run docs:examples first.');
  },
  vite: {
    // the examples served by the dev server, as the deployed site has them
    plugins: [
      serveExamples(
        builtExamples,
        base,
        new Set([...GAMES, ...BASICS, ...TOOLS].map((example) => example.path.split('/')[1] ?? '')),
      ),
    ],
    // the landing page's live sea runs against the engine's sources, as the examples do
    resolve: {
      alias: [
        { find: /^eulerjs$/, replacement: sourceOf('eulerjs') },
        { find: /^eulerjs\/extend$/, replacement: sourceOf('eulerjs', 'extend') },
        { find: /^@eulerjs\/marine$/, replacement: sourceOf('marine') },
        { find: /^@eulerjs\/marine\/webgpu$/, replacement: sourceOf('marine', 'webgpu/index') },
      ],
    },
  },
  markdown: {
    theme: { light: 'github-light', dark: 'github-dark' },
    lineNumbers: false,
  },
  themeConfig: {
    logo: '/logo.png',
    nav: [
      { text: 'Guide', link: '/guide/getting-started', activeMatch: '^/guide/' },
      { text: 'Plugins', link: '/marine/', activeMatch: '^/(marine|vehicle|bvh)' },
      { text: 'Examples', link: '/examples/', activeMatch: '^/examples/' },
      { text: 'API', link: '/api/', activeMatch: '^/api/' },
    ],
    sidebar: {
      '/guide/': guide,
      '/marine/': plugins,
      '/vehicle': plugins,
      '/bvh': plugins,
      '/api/': [{ text: 'API reference', items: apiSidebar() }],
    },
    socialLinks: [{ icon: 'github', link: REPOSITORY }],
    editLink: {
      // the API reference is generated from the sources' comments: those are what to edit
      // (runs in the browser, where only what is written in it exists: hence the address in full)
      pattern: ({ filePath }) => (filePath.startsWith('api/') ? 'https://github.com/QusaiAlbonni/eulerjs/tree/main/packages' : `https://github.com/QusaiAlbonni/eulerjs/edit/main/docs/${filePath}`),
      text: 'Edit this page on GitHub',
    },
    search: { provider: 'local' },
    outline: { level: [2, 3] },
    footer: {
      message: 'Released under the MIT License.',
      copyright: 'Copyright © Qusay Albonni',
    },
  },
});

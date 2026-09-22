import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

export default defineConfig({
  root: __dirname,
  base: '/workbench/',
  plugins: [vue()],
  // components/theme.ts lazily imports @slidev/client to follow the deck's
  // dark-mode toggle. That import path is only resolvable inside Slidev's
  // pipeline (it contains virtual modules), so in the standalone workbench we
  // alias it to a stub: the stub's useDarkMode() rejects, theme.ts catches it,
  // and the workbench follows prefers-color-scheme instead.
  resolve: {
    alias: {
      '@slidev/client': new URL('./slidev-client-stub.ts', import.meta.url).pathname,
    },
  },
  server: { port: 3032 },
  build: { outDir: '../dist-bench', emptyOutDir: true },
})

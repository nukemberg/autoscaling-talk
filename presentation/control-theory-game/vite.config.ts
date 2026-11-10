import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

// Standalone app, served at /shower/ next to the slides (and /workbench/). No Slidev deps.
export default defineConfig({
  root: __dirname,
  base: '/shower/',
  plugins: [vue()],
  server: { port: 3033 },
  build: { outDir: '../dist-game', emptyOutDir: true },
})

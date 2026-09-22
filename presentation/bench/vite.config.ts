import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

export default defineConfig({
  root: __dirname,
  base: '/workbench/',
  plugins: [vue()],
  server: { port: 3032 },
  build: { outDir: '../dist-bench', emptyOutDir: true },
})

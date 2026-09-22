import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    lib: { entry: 'profile/count.ts', formats: ['es'], fileName: () => 'count.js' },
    outDir: 'profile/dist',
    target: 'node25',
    minify: false,
    emptyOutDir: false,
  },
})

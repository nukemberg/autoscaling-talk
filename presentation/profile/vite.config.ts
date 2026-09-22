import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    lib: { entry: 'profile/entry.ts', formats: ['es'], fileName: () => 'entry.js' },
    outDir: 'profile/dist',
    target: 'node25',
    minify: false,
    emptyOutDir: true,
  },
})

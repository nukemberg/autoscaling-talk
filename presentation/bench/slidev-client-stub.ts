/**
 * Stand-in for `@slidev/client` when the shared chart components run in the
 * standalone workbench (bench/), which builds without Slidev's vite plugins
 * and therefore can't resolve Slidev's real module graph. theme.ts catches the
 * rejection and falls back to `prefers-color-scheme`.
 */
export function useDarkMode(): never {
  throw new Error('@slidev/client is not available outside Slidev')
}

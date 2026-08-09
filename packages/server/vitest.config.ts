import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // dist/ holds compiled copies of these same specs; running both would
    // double-count and silently test stale build output.
    include: ['src/**/*.test.ts'],
    exclude: ['dist/**', 'node_modules/**'],
  },
})

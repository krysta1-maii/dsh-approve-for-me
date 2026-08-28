import { defineConfig } from 'vitest/config'

/**
 * The patch overlay tests (`patch/**`) run inside the upstream
 * `dsh-user-approval` workspace against the patched sources; this repo's
 * suite still runs against the installed 0.1.1-rc.2 baseline and must not
 * pick them up.
 */
export default defineConfig({
  test: {
    exclude: ['node_modules/**', 'patch/**', '.build/**'],
  },
})

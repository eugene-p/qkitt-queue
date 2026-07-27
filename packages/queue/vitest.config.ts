import { defineConfig } from 'vitest/config'

export default defineConfig({
    test: {
        // Playwright browser specs live under browser/ and use a different runner.
        include: ['src/**/*.test.ts'],
    },
})

import { defineConfig } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const port = Number(process.env.QKITT_BROWSER_PORT ?? 4173)
const host = process.env.QKITT_BROWSER_HOST ?? '127.0.0.1'
const baseURL = `http://${host}:${port}`

export default defineConfig({
  testDir: __dirname,
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL,
    headless: true,
    trace: 'on-first-retry',
  },
  webServer: {
    command: `node "${path.join(__dirname, 'static-server.mjs')}"`,
    url: `${baseURL}/harness.html`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      ...process.env,
      QKITT_BROWSER_PORT: String(port),
      QKITT_BROWSER_HOST: host,
    },
  },
  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium' },
    },
  ],
})

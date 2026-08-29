import { defineConfig, devices } from '@playwright/test'

const DEFAULT_E2E_PORT = 4179
const port = Number(process.env.TPLAYER_E2E_PORT ?? DEFAULT_E2E_PORT)
const baseURL = `http://127.0.0.1:${port}`

export default defineConfig({
	expect: { timeout: 15_000 },
	fullyParallel: false,
	outputDir: 'test-results/playwright',
	reporter: [['line']],
	retries: process.env.CI ? 1 : 0,
	testDir: './e2e',
	timeout: 150_000,
	use: {
		...devices['Desktop Chrome'],
		baseURL,
		screenshot: 'only-on-failure',
		serviceWorkers: 'block',
		trace: 'retain-on-failure',
		video: 'off',
	},
	webServer: {
		command: `TPLAYER_E2E_PORT=${port} bun run build:frontend && TPLAYER_E2E_PORT=${port} bun run e2e/server.ts`,
		reuseExistingServer: false,
		stderr: 'pipe',
		stdout: 'pipe',
		timeout: 120_000,
		url: `${baseURL}/__e2e/fixture`,
	},
	workers: 1,
})

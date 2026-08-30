import { expect, test } from '@playwright/test'

const MIGRATION_DATABASE = 'tplayer-service-worker-migration-proof'
const MIGRATION_STORE = 'offline'
const MIGRATION_KEY = 'preserved-audiobook'
const MIGRATION_STORAGE = {
	databaseName: MIGRATION_DATABASE,
	key: MIGRATION_KEY,
	storeName: MIGRATION_STORE,
}

interface MigrationStorage {
	databaseName: string
	key: string
	storeName: string
}

const writeMigrationMarker = async ({
	databaseName,
	key,
	storeName,
}: MigrationStorage): Promise<void> => {
	await new Promise<void>((resolve, reject) => {
		const request = indexedDB.open(databaseName, 1)
		request.onupgradeneeded = () => {
			request.result.createObjectStore(storeName)
		}
		request.onerror = () => reject(request.error)
		request.onsuccess = () => {
			const database = request.result
			const transaction = database.transaction(storeName, 'readwrite')
			transaction.objectStore(storeName).put('bytes remain', key)
			transaction.oncomplete = () => {
				database.close()
				resolve()
			}
			transaction.onerror = () => reject(transaction.error)
		}
	})
}

const readMigrationMarker = async ({
	databaseName,
	key,
	storeName,
}: MigrationStorage): Promise<unknown> =>
	await new Promise((resolve, reject) => {
		const request = indexedDB.open(databaseName)
		request.onerror = () => reject(request.error)
		request.onsuccess = () => {
			const database = request.result
			const transaction = database.transaction(storeName, 'readonly')
			const getRequest = transaction.objectStore(storeName).get(key)
			getRequest.onerror = () => reject(getRequest.error)
			getRequest.onsuccess = () => resolve(getRequest.result)
			transaction.oncomplete = () => database.close()
		}
	})

test('a newly activated worker replaces a legacy shell without deleting IndexedDB', async ({
	baseURL,
	browser,
	request,
}) => {
	if (!baseURL) {
		throw new Error('Playwright baseURL is required')
	}
	const context = await browser.newContext({ serviceWorkers: 'allow' })
	const page = await context.newPage()
	try {
		await request.post('/__e2e/service-worker-mode', {
			data: { legacy: true },
		})
		await page.goto(`${baseURL}/__e2e/install-legacy-worker`)
		await expect(page.locator('body')).toHaveAttribute(
			'data-worker-ready',
			'true'
		)
		await page.evaluate(writeMigrationMarker, MIGRATION_STORAGE)
		await page.goto(`${baseURL}/`)
		await expect(page.getByTestId('legacy-shell')).toHaveText(
			'legacy app shell'
		)

		await request.post('/__e2e/service-worker-mode', {
			data: { legacy: false },
		})
		await page.evaluate(async () => {
			const registration = await navigator.serviceWorker.getRegistration()
			if (!registration) {
				throw new Error('Legacy service worker registration is missing')
			}
			await registration.update()
		})

		await expect(page.getByRole('searchbox')).toBeVisible({ timeout: 20_000 })
		await expect(page.getByTestId('legacy-shell')).toHaveCount(0)
		expect(await page.evaluate(readMigrationMarker, MIGRATION_STORAGE)).toBe(
			'bytes remain'
		)
	} finally {
		await request.post('/__e2e/service-worker-mode', {
			data: { legacy: false },
		})
		await context.close()
	}
})

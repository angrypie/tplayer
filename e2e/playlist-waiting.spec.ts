import { expect, type Page, test } from '@playwright/test'

const INFO_HASH = '7d54313f07d232e3880d191371bd8270a099ec75'
const BOOK_NAME = 'Route-mocked background audiobook'
const AUDIO_FILE_NAME = 'chapter-01.mp3'
const MEBIBYTE = 1024 * 1024
const DOWNLOADED_BYTES = MEBIBYTE
const TOTAL_BYTES = 4 * MEBIBYTE
const DOWNLOAD_SPEED = 128 * 1024
const AUTHORIZATION_CHECKBOX_PATTERN =
	/I understand that I must be legally authorized/
const STATUS_ROUTE = `**/api/torrents/${INFO_HASH}/status`
const DETAILS_ROUTE = `**/api/torrents/${INFO_HASH}`
const COLLECTION_ROUTE = '**/api/torrents'
const FILE_ROUTE = `**/api/torrents/${INFO_HASH}/files/**`

interface CachedMetadataSeed {
	audioFileName: string
	bookName: string
	infoHash: string
	totalBytes: number
}

const seedCachedMetadata = async (page: Page): Promise<void> => {
	await page.goto('/')
	await page.evaluate(
		async ({
			audioFileName,
			bookName,
			infoHash,
			totalBytes,
		}: CachedMetadataSeed): Promise<void> => {
			const database = await new Promise<IDBDatabase>((resolve, reject) => {
				const request = indexedDB.open('books')
				request.onerror = () => reject(request.error)
				request.onsuccess = () => resolve(request.result)
			})
			try {
				await new Promise<void>((resolve, reject) => {
					const transaction = database.transaction('torrents', 'readwrite')
					transaction.onerror = () => reject(transaction.error)
					transaction.oncomplete = () => resolve()
					transaction.objectStore('torrents').put({
						ih: infoHash,
						info: {
							files: [
								{
									id: '0',
									length: totalBytes,
									mimeType: 'audio/mpeg',
									name: audioFileName,
									path: [audioFileName],
								},
							],
							infoHash,
							length: totalBytes,
							name: bookName,
						},
						state: {
							path: [audioFileName],
							time: 42,
							updatedAt: Date.now(),
						},
					})
				})
			} finally {
				database.close()
			}
		},
		{
			audioFileName: AUDIO_FILE_NAME,
			bookName: BOOK_NAME,
			infoHash: INFO_HASH,
			totalBytes: TOTAL_BYTES,
		}
	)
}

const torrentStatus = (metadataReady: boolean) => {
	if (metadataReady) {
		return {
			downloadedBytes: DOWNLOADED_BYTES,
			downloadSpeed: DOWNLOAD_SPEED,
			infoHash: INFO_HASH,
			metadataReady: true,
			name: BOOK_NAME,
			numPeers: 3,
			progress: 0.25,
			state: 'downloading',
			totalBytes: TOTAL_BYTES,
		}
	}
	return {
		downloadedBytes: 0,
		downloadSpeed: 0,
		infoHash: INFO_HASH,
		metadataReady: false,
		name: INFO_HASH,
		numPeers: 0,
		progress: 0,
		state: 'fetching_metadata',
		totalBytes: 0,
	}
}

test('direct playlist navigation authorizes background download and exposes progress', async ({
	page,
}) => {
	let registrationRequests = 0
	let statusRequests = 0
	let detailsRequests = 0
	const responseState = { metadataReady: false }

	await page.route(COLLECTION_ROUTE, async (route) => {
		if (route.request().method() === 'GET') {
			await route.fulfill({
				json: [
					{
						cachedBytes: DOWNLOADED_BYTES,
						firstSeen: '2026-08-31T10:00:00.000Z',
						infoHash: INFO_HASH,
						lastSeen: '2026-08-31T10:01:00.000Z',
						name: BOOK_NAME,
					},
				],
			})
			return
		}

		registrationRequests += 1
		expect(route.request().method()).toBe('POST')
		expect(route.request().postDataJSON()).toEqual({
			download: true,
			torrentId: INFO_HASH,
		})
		await route.fulfill({
			json: { infoHash: INFO_HASH, metadataReady: false },
			status: 202,
		})
	})

	await page.route(DETAILS_ROUTE, async (route) => {
		detailsRequests += 1
		await route.fulfill({
			json: {
				downloaded: DOWNLOADED_BYTES,
				downloadSpeed: DOWNLOAD_SPEED,
				files: [
					{
						downloaded: DOWNLOADED_BYTES,
						id: '0',
						length: TOTAL_BYTES,
						mimeType: 'audio/mpeg',
						name: AUDIO_FILE_NAME,
						path: [AUDIO_FILE_NAME],
						progress: 0.25,
					},
				],
				infoHash: INFO_HASH,
				length: TOTAL_BYTES,
				name: BOOK_NAME,
				numPeers: 3,
				progress: 0.25,
				ready: true,
			},
		})
	})

	await page.route(STATUS_ROUTE, async (route) => {
		statusRequests += 1
		if (registrationRequests === 0) {
			await route.fulfill({
				json: {
					error: {
						code: 'torrent_not_found',
						message: 'Torrent was not found',
					},
				},
				status: 404,
			})
			return
		}

		await route.fulfill({
			json: torrentStatus(responseState.metadataReady),
		})
	})

	await page.goto(`/playlist/${INFO_HASH}`)

	const authorizationDialog = page.getByRole('dialog')
	await expect(authorizationDialog).toContainText(
		'Before opening peer-to-peer content'
	)
	const notFoundStatus = page.locator('section[data-server-state="not-found"]')
	await expect(notFoundStatus).toContainText(
		'This torrent is not on the server'
	)
	await expect(notFoundStatus.locator('details')).not.toHaveAttribute(
		'open',
		''
	)
	expect(statusRequests).toBeGreaterThan(0)
	expect(registrationRequests).toBe(0)
	expect(detailsRequests).toBe(0)

	await authorizationDialog
		.getByRole('button', { exact: true, name: 'Cancel' })
		.click()
	await expect(authorizationDialog).toHaveCount(0)
	expect(registrationRequests).toBe(0)

	await notFoundStatus.locator('summary').click()
	await page
		.getByRole('button', {
			exact: true,
			name: 'Start server download',
		})
		.click()
	await expect(authorizationDialog).toBeVisible()
	const confirmButton = authorizationDialog.getByRole('button', {
		exact: true,
		name: 'I understand — continue',
	})
	await expect(confirmButton).toBeDisabled()
	expect(registrationRequests).toBe(0)

	await authorizationDialog
		.getByRole('checkbox', { name: AUTHORIZATION_CHECKBOX_PATTERN })
		.check()
	await confirmButton.click()
	await expect.poll(() => registrationRequests).toBe(1)

	const metadataStatus = page.locator(
		'section[data-server-state="fetching_metadata"]'
	)
	await expect(metadataStatus).toBeVisible()
	await expect(metadataStatus).toHaveAttribute('aria-busy', 'true')
	await metadataStatus.locator('summary').click()
	await expect(metadataStatus.locator('details')).not.toHaveAttribute(
		'open',
		''
	)
	await expect(
		metadataStatus.getByRole('heading', { name: 'Finding book details…' })
	).toBeVisible()
	const metadataProgress = metadataStatus.getByRole('progressbar', {
		name: 'Server download progress',
	})
	await expect(metadataProgress).toBeVisible()
	await expect(metadataProgress).not.toHaveAttribute('value')
	await expect(metadataStatus).toContainText(
		'Its background job continues if you leave this page.'
	)
	await expect(
		metadataStatus.getByText(
			'The server is finding the book details. Its background job continues if you leave this page.',
			{ exact: true }
		)
	).not.toBeVisible()
	expect(detailsRequests).toBe(0)

	responseState.metadataReady = true

	const downloadStatus = page.locator(
		'section[data-server-state="downloading"]'
	)
	await expect(downloadStatus).toBeVisible()
	await expect(downloadStatus).toHaveAttribute('aria-busy', 'true')
	await expect(
		downloadStatus.getByRole('heading', {
			name: 'Downloading on the server',
		})
	).toBeVisible()
	const progress = downloadStatus.getByRole('progressbar', {
		name: 'Server download progress',
	})
	await expect(progress).toHaveAttribute('max', '100')
	await expect(progress).toHaveAttribute('value', '25')
	await expect(downloadStatus.locator('details')).not.toHaveAttribute(
		'open',
		''
	)
	await expect(
		downloadStatus.getByText('25% · 1 MB of 4 MB', { exact: true })
	).not.toBeVisible()
	await downloadStatus.locator('summary').click()
	await expect(downloadStatus).toContainText('25% · 1 MB of 4 MB')
	await expect(downloadStatus).toContainText('128 KB/s')
	await expect(downloadStatus).toContainText('3 peers')
	await expect(downloadStatus).toContainText(
		'You can leave this page and return later.'
	)

	await expect(page.getByText(BOOK_NAME, { exact: true })).toBeVisible()
	await expect(page.getByText(AUDIO_FILE_NAME, { exact: true })).toBeVisible()
	await expect.poll(() => detailsRequests).toBeGreaterThan(0)
	expect(registrationRequests).toBe(1)
})

test('registered playlist access remembers the first-use acknowledgement without registering again', async ({
	page,
}) => {
	let detailsRequests = 0
	let registrationRequests = 0

	await page.route(COLLECTION_ROUTE, async (route) => {
		if (route.request().method() === 'POST') {
			registrationRequests += 1
		}
		await route.fulfill({ json: [] })
	})
	await page.route(DETAILS_ROUTE, async (route) => {
		detailsRequests += 1
		await route.fulfill({
			json: {
				downloaded: DOWNLOADED_BYTES,
				downloadSpeed: DOWNLOAD_SPEED,
				files: [
					{
						downloaded: DOWNLOADED_BYTES,
						id: '0',
						length: TOTAL_BYTES,
						mimeType: 'audio/mpeg',
						name: AUDIO_FILE_NAME,
						path: [AUDIO_FILE_NAME],
						progress: 0.25,
					},
				],
				infoHash: INFO_HASH,
				length: TOTAL_BYTES,
				name: BOOK_NAME,
				numPeers: 3,
				progress: 0.25,
				ready: true,
			},
		})
	})
	await page.route(STATUS_ROUTE, async (route) => {
		await route.fulfill({ json: torrentStatus(true) })
	})

	await page.goto(`/playlist/${INFO_HASH}`)

	const authorizationDialog = page.getByRole('dialog')
	await expect(authorizationDialog).toContainText(
		'Before opening peer-to-peer content'
	)
	await expect(
		page.locator('section[data-server-state="downloading"]')
	).toBeVisible()
	await page.waitForTimeout(250)
	expect(detailsRequests).toBe(0)
	expect(registrationRequests).toBe(0)

	await authorizationDialog
		.getByRole('button', { exact: true, name: 'Cancel' })
		.click()
	await expect(authorizationDialog).toHaveCount(0)
	await page.waitForTimeout(250)
	expect(detailsRequests).toBe(0)
	expect(registrationRequests).toBe(0)

	await page.locator('section[data-server-state="downloading"] summary').click()
	await page.getByRole('button', { exact: true, name: 'Open book' }).click()
	await authorizationDialog
		.getByRole('checkbox', { name: AUTHORIZATION_CHECKBOX_PATTERN })
		.check()
	await authorizationDialog
		.getByRole('button', {
			exact: true,
			name: 'I understand — continue',
		})
		.click()

	await expect(page.getByText(BOOK_NAME, { exact: true })).toBeVisible()
	await expect(page.getByText(AUDIO_FILE_NAME, { exact: true })).toBeVisible()
	await expect.poll(() => detailsRequests).toBeGreaterThan(0)
	expect(registrationRequests).toBe(0)

	await page.goto(`/playlist/${INFO_HASH}`)
	await expect(page.getByRole('dialog')).toHaveCount(0)
	await expect(page.getByText(BOOK_NAME, { exact: true })).toBeVisible()
	await expect(
		page.getByRole('button', { name: new RegExp(AUDIO_FILE_NAME) })
	).toBeEnabled()
	expect(registrationRequests).toBe(0)
})

test('completed server downloads stay minimal until their details are opened', async ({
	page,
}) => {
	let registrationRequests = 0

	await page.route(COLLECTION_ROUTE, async (route) => {
		if (route.request().method() === 'POST') {
			registrationRequests += 1
		}
		await route.fulfill({ json: [] })
	})
	await page.route(DETAILS_ROUTE, async (route) => {
		await route.fulfill({
			json: {
				downloaded: TOTAL_BYTES,
				downloadSpeed: 0,
				files: [
					{
						downloaded: TOTAL_BYTES,
						id: '0',
						length: TOTAL_BYTES,
						mimeType: 'audio/mpeg',
						name: AUDIO_FILE_NAME,
						path: [AUDIO_FILE_NAME],
						progress: 1,
					},
				],
				infoHash: INFO_HASH,
				length: TOTAL_BYTES,
				name: BOOK_NAME,
				numPeers: 0,
				progress: 1,
				ready: true,
			},
		})
	})
	await page.route(STATUS_ROUTE, async (route) => {
		await route.fulfill({
			json: {
				downloadedBytes: TOTAL_BYTES,
				downloadSpeed: 0,
				infoHash: INFO_HASH,
				metadataReady: true,
				name: BOOK_NAME,
				numPeers: 0,
				progress: 1,
				state: 'completed',
				totalBytes: TOTAL_BYTES,
			},
		})
	})

	await page.goto(`/playlist/${INFO_HASH}`)
	const authorizationDialog = page.getByRole('dialog')
	await authorizationDialog
		.getByRole('checkbox', { name: AUTHORIZATION_CHECKBOX_PATTERN })
		.check()
	await authorizationDialog
		.getByRole('button', {
			exact: true,
			name: 'I understand — continue',
		})
		.click()

	const completedStatus = page.locator('section[data-server-state="completed"]')
	await expect(
		completedStatus.getByRole('heading', { name: 'Downloaded on server' })
	).toBeVisible()
	await expect(completedStatus.locator('details')).not.toHaveAttribute(
		'open',
		''
	)
	await expect(
		completedStatus.getByText(
			'The server finished downloading this torrent and can keep serving its files.',
			{ exact: true }
		)
	).not.toBeVisible()
	await expect(
		completedStatus.getByRole('progressbar', {
			name: 'Server download progress',
		})
	).toHaveCount(0)

	await completedStatus.locator('summary').click()
	await expect(completedStatus).toContainText('100% · 4 MB of 4 MB')
	await expect(completedStatus).toContainText('0 peers')
	expect(registrationRequests).toBe(0)
})

test('a failed download retries without repeating the first-use acknowledgement', async ({
	page,
}) => {
	let registrationRequests = 0
	const responseState = { state: 'failed' }

	await page.route(COLLECTION_ROUTE, async (route) => {
		if (route.request().method() === 'POST') {
			registrationRequests += 1
			responseState.state = 'fetching_metadata'
			await route.fulfill({
				json: { infoHash: INFO_HASH, metadataReady: false },
				status: 202,
			})
			return
		}
		await route.fulfill({ json: [] })
	})
	await page.route(STATUS_ROUTE, async (route) => {
		await route.fulfill({
			json: {
				...torrentStatus(false),
				error:
					responseState.state === 'failed' ? 'The swarm stalled' : undefined,
				state: responseState.state,
			},
		})
	})

	await page.goto(`/playlist/${INFO_HASH}`)
	const authorizationDialog = page.getByRole('dialog')
	await authorizationDialog
		.getByRole('checkbox', { name: AUTHORIZATION_CHECKBOX_PATTERN })
		.check()
	await authorizationDialog
		.getByRole('button', {
			exact: true,
			name: 'I understand — continue',
		})
		.click()

	await page.locator('section[data-server-state="failed"] summary').click()
	await expect(
		page.getByRole('button', { exact: true, name: 'Retry server download' })
	).toBeVisible()
	expect(registrationRequests).toBe(0)

	await page
		.getByRole('button', { exact: true, name: 'Retry server download' })
		.click()
	await expect(authorizationDialog).toHaveCount(0)

	await expect.poll(() => registrationRequests).toBe(1)
	await expect(
		page.locator('section[data-server-state="fetching_metadata"]')
	).toBeVisible()
})

test('Home authorization grants one playlist navigation without a second dialog', async ({
	page,
}) => {
	let detailsRequests = 0
	let registrationRequests = 0

	await page.route(COLLECTION_ROUTE, async (route) => {
		if (route.request().method() === 'GET') {
			await route.fulfill({ json: [] })
			return
		}
		registrationRequests += 1
		await route.fulfill({
			json: { infoHash: INFO_HASH, metadataReady: true },
			status: 202,
		})
	})
	await page.route(DETAILS_ROUTE, async (route) => {
		detailsRequests += 1
		await route.fulfill({
			json: {
				downloaded: DOWNLOADED_BYTES,
				downloadSpeed: DOWNLOAD_SPEED,
				files: [
					{
						downloaded: DOWNLOADED_BYTES,
						id: '0',
						length: TOTAL_BYTES,
						mimeType: 'audio/mpeg',
						name: AUDIO_FILE_NAME,
						path: [AUDIO_FILE_NAME],
						progress: 0.25,
					},
				],
				infoHash: INFO_HASH,
				length: TOTAL_BYTES,
				name: BOOK_NAME,
				numPeers: 3,
				progress: 0.25,
				ready: true,
			},
		})
	})
	await page.route(STATUS_ROUTE, async (route) => {
		await route.fulfill({ json: torrentStatus(true) })
	})

	await page.goto('/')
	await page
		.getByRole('searchbox', {
			name: 'Search audiobooks or paste an authorized magnet link or info hash',
		})
		.fill(INFO_HASH)
	await page.getByRole('button', { exact: true, name: 'Open torrent' }).click()

	const authorizationDialog = page.getByRole('dialog')
	await authorizationDialog
		.getByRole('checkbox', { name: AUTHORIZATION_CHECKBOX_PATTERN })
		.check()
	await authorizationDialog
		.getByRole('button', {
			exact: true,
			name: 'I understand — continue',
		})
		.click()

	await expect(page).toHaveURL(new RegExp(`/playlist/${INFO_HASH}$`))
	await expect(page.getByRole('dialog')).toHaveCount(0)
	await expect(page.getByText(BOOK_NAME, { exact: true })).toBeVisible()
	await expect.poll(() => detailsRequests).toBeGreaterThan(0)
	expect(registrationRequests).toBe(1)
})

test('cached metadata cannot resolve a server file before fresh authorization', async ({
	page,
}) => {
	let detailsRequests = 0
	let fileRequests = 0
	let registrationRequests = 0

	await page.route(COLLECTION_ROUTE, async (route) => {
		if (route.request().method() === 'POST') {
			registrationRequests += 1
		}
		await route.fulfill({ json: [] })
	})
	await page.route(DETAILS_ROUTE, async (route) => {
		detailsRequests += 1
		await route.fulfill({ json: {}, status: 500 })
	})
	await page.route(STATUS_ROUTE, async (route) => {
		await route.fulfill({
			json: {
				error: {
					code: 'torrent_not_found',
					message: 'Torrent was not found',
				},
			},
			status: 404,
		})
	})
	await page.route(FILE_ROUTE, async (route) => {
		fileRequests += 1
		await route.fulfill({ body: '', status: 500 })
	})

	await seedCachedMetadata(page)
	await page.goto(`/playlist/${INFO_HASH}`)

	await expect(page.getByRole('dialog')).toContainText(
		'Before opening peer-to-peer content'
	)
	await expect(page.getByText(BOOK_NAME, { exact: true })).toBeVisible()
	await expect(
		page.getByRole('button', { name: new RegExp(AUDIO_FILE_NAME) })
	).toBeDisabled()
	await page.waitForTimeout(250)

	expect(registrationRequests).toBe(0)
	expect(detailsRequests).toBe(0)
	expect(fileRequests).toBe(0)
})

test('does not repeat authorization when an accepted torrent is missing afterward', async ({
	page,
}) => {
	let registrationRequests = 0
	let statusRequests = 0

	await page.route(COLLECTION_ROUTE, async (route) => {
		if (route.request().method() === 'GET') {
			await route.fulfill({ json: [] })
			return
		}
		registrationRequests += 1
		await route.fulfill({
			json: { infoHash: INFO_HASH, metadataReady: false },
			status: 202,
		})
	})
	await page.route(STATUS_ROUTE, async (route) => {
		statusRequests += 1
		if (registrationRequests === 0) {
			await route.fulfill({
				json: {
					error: {
						code: 'torrent_not_found',
						message: 'Torrent was not found',
					},
				},
				status: 404,
			})
			return
		}
		await route.fulfill({
			json: {
				error: {
					code: 'torrent_not_found',
					message: 'Torrent was not found',
				},
			},
			status: 404,
		})
	})

	await page.goto(`/playlist/${INFO_HASH}`)
	const authorizationDialog = page.getByRole('dialog')
	await authorizationDialog
		.getByRole('checkbox', { name: AUTHORIZATION_CHECKBOX_PATTERN })
		.check()
	await authorizationDialog
		.getByRole('button', {
			exact: true,
			name: 'I understand — continue',
		})
		.click()

	const unavailableStatus = page.locator(
		'section[data-server-state="connection-error"]'
	)
	await unavailableStatus.locator('summary').click()
	await expect(unavailableStatus).toContainText(
		'The server accepted this torrent but could not report the background job afterward'
	)
	await expect(
		page.getByRole('button', { exact: true, name: 'Check again' })
	).toBeVisible()
	await expect(
		page.getByRole('button', {
			exact: true,
			name: 'Start server download',
		})
	).toHaveCount(0)
	await expect(authorizationDialog).toHaveCount(0)
	await page.waitForTimeout(2000)

	expect(registrationRequests).toBe(1)
	expect(statusRequests).toBe(2)
})

test('does not offer authorization when an older server lacks the status route', async ({
	page,
}) => {
	let registrationRequests = 0
	let statusRequests = 0

	await page.route(COLLECTION_ROUTE, async (route) => {
		if (route.request().method() === 'POST') {
			registrationRequests += 1
		}
		await route.fulfill({ json: [] })
	})
	await page.route(STATUS_ROUTE, async (route) => {
		statusRequests += 1
		await route.fulfill({
			json: {
				error: {
					code: 'not_found',
					message: 'API route was not found',
				},
			},
			status: 404,
		})
	})

	await page.goto(`/playlist/${INFO_HASH}`)
	const unavailableStatus = page.locator(
		'section[data-server-state="connection-error"]'
	)
	await unavailableStatus.locator('summary').click()
	await expect(unavailableStatus).toContainText(
		'This TPlayer server needs to be updated or restarted'
	)
	await expect(page.getByRole('dialog')).toHaveCount(0)
	await expect(
		page.getByRole('button', {
			exact: true,
			name: 'Start server download',
		})
	).toHaveCount(0)
	await page.waitForTimeout(2000)

	expect(registrationRequests).toBe(0)
	expect(statusRequests).toBe(1)
})

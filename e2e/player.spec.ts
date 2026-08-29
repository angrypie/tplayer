import { type APIResponse, expect, type Page, test } from '@playwright/test'
import { CONTENT_USE_POLICY_VERSION } from '../src/search/contentPolicy'
import { SEARCH_PREFERENCES_KEY } from '../src/search/preferences'

const BACK_TO_LIBRARY_PATTERN = /Back to library/
const AUTHORIZATION_CHECKBOX_PATTERN = /I confirm that I am legally authorized/
const AUTHORIZED_UPLOAD_PATTERN = /authorized.+upload pieces/s
const BYTE_RANGE_PATTERN = /^bytes=/
const CLEAN_BOOK_PATTERN = /^Clean book data \(/
const CONTENT_RANGE_PATTERN = /^bytes 0-/
const OPEN_LIBRIVOX_RESULT_PATTERN = /^Open .+ from LibriVox$/
const OPEN_TRACKER_RESULT_PATTERN = /^Open .+ from AudioBookBay$/
const TRACKER_ACKNOWLEDGEMENT_PATTERN =
	/I understand and will use tracker results only/

interface FixtureDescriptor {
	files: Array<{
		bytes: number
		name: string
		path: string
		sha256: string
	}>
	infoHash: string
	magnetUri: string
	name: string
	totalBytes: number
}

interface FileRequestMetric {
	contentLength: number
	contentRange: string | null
	method: string
	range: string | null
	status: number
}

interface TransferMetrics {
	downloaderDownloadedBytes: number
	fileRequests: FileRequestMetric[]
	manager: {
		activeSessions: number
		destroyed: boolean
		preloadJobs: number
	}
	seederUploadedBytes: number
}

interface PreloadStatus {
	downloadedBytes: number
	state: 'completed' | 'failed' | 'running'
	totalBytes: number
}

interface SearchUpstreamMetrics {
	archiveMetadataRequests: number
	audiobookBayDetailRequests: number
	audiobookBaySearchRequests: number
	internetArchiveSearchRequests: number
	librivoxSearchRequests: number
}

interface RegistrationMetrics {
	searchResolveRequests: number
	torrentRegistrationRequests: number
}

const readJson = async <Value>(response: APIResponse): Promise<Value> => {
	expect(response.ok(), await response.text()).toBe(true)
	return (await response.json()) as Value
}

const getCachedFileCount = async (
	page: Page,
	infoHash: string
): Promise<number> =>
	await page.evaluate(
		async ({ databaseName, hash }) => {
			const database = await new Promise<IDBDatabase>((resolve, reject) => {
				const request = indexedDB.open(databaseName)
				request.onerror = () => reject(request.error)
				request.onsuccess = () => resolve(request.result)
			})
			try {
				return await new Promise<number>((resolve, reject) => {
					const transaction = database.transaction('files', 'readonly')
					const request = transaction
						.objectStore('files')
						.index('ih')
						.count(hash)
					request.onerror = () => reject(request.error)
					request.onsuccess = () => resolve(request.result)
				})
			} finally {
				database.close()
			}
		},
		{ databaseName: 'books', hash: infoHash }
	)

const getSavedPlaybackTime = async (
	page: Page,
	infoHash: string
): Promise<number> =>
	await page.evaluate(
		async ({ databaseName, hash }) => {
			const database = await new Promise<IDBDatabase>((resolve, reject) => {
				const request = indexedDB.open(databaseName)
				request.onerror = () => reject(request.error)
				request.onsuccess = () => resolve(request.result)
			})
			try {
				const record = await new Promise<unknown>((resolve, reject) => {
					const transaction = database.transaction('torrents', 'readonly')
					const request = transaction.objectStore('torrents').get(hash)
					request.onerror = () => reject(request.error)
					request.onsuccess = () => resolve(request.result as unknown)
				})
				if (typeof record !== 'object' || record === null) {
					return 0
				}
				const { state } = record as { state?: unknown }
				if (typeof state !== 'object' || state === null) {
					return 0
				}
				const { time } = state as { time?: unknown }
				return typeof time === 'number' && Number.isFinite(time) ? time : 0
			} finally {
				database.close()
			}
		},
		{ databaseName: 'books', hash: infoHash }
	)

const openAction = async (page: Page, name: string): Promise<void> => {
	await page.getByRole('button', { exact: true, name: 'Actions' }).click()
	await page.getByRole('button', { exact: true, name }).click()
}

const confirmAction = async (
	page: Page,
	title: string,
	requiredText?: RegExp
): Promise<void> => {
	const dialog = page.getByRole('dialog')
	await expect(dialog).toContainText(title)
	if (requiredText) {
		await expect(dialog).toContainText(requiredText)
	}
	await page.getByRole('button', { exact: true, name: 'Confirm' }).click()
}

test.afterAll(async ({ request }) => {
	const response = await request.post('/__e2e/cleanup')
	expect(response.status()).toBe(204)
})

test('a real private torrent plays, persists offline, and follows full lifecycle', async ({
	page,
}) => {
	const pageErrors: string[] = []
	page.on('pageerror', (error) => {
		pageErrors.push(error.message)
	})

	const fixture = await readJson<FixtureDescriptor>(
		await page.request.get('/__e2e/fixture')
	)
	const firstAudio = fixture.files.find((file) => file.name.startsWith('01 -'))
	expect(
		firstAudio,
		'The deterministic swarm must include the first WAV'
	).toBeDefined()

	await test.step('rights-labelled sources stay smooth while unverified sources require explicit authorization', async () => {
		await page.goto('/')
		await page.evaluate((storageKey) => {
			localStorage.setItem(
				storageKey,
				JSON.stringify({
					enabledOptionalProviderIds: ['audiobook-bay', 'removed-provider'],
				})
			)
		}, SEARCH_PREFERENCES_KEY)
		const searchbox = page.getByRole('searchbox', {
			name: 'Search audiobooks or paste an authorized magnet link or info hash',
		})
		await searchbox.fill('private swarm')
		await page.getByRole('button', { exact: true, name: 'search' }).click()
		await expect(
			page.getByRole('heading', {
				exact: true,
				name: 'Public-domain and rights-labelled audiobooks',
			})
		).toBeVisible()
		await expect(page.getByText('LibriVox', { exact: true })).toBeVisible()
		await expect(
			page.getByText('Internet Archive', { exact: true })
		).toBeVisible()
		await expect(
			page.getByRole('link', { exact: true, name: 'Rights information' })
		).toBeVisible()
		await expect(
			page.getByRole('heading', {
				exact: true,
				name: 'Unverified third-party results',
			})
		).toHaveCount(0)
		let searchMetrics = await readJson<SearchUpstreamMetrics>(
			await page.request.get('/__e2e/search-metrics')
		)
		expect(searchMetrics.audiobookBaySearchRequests).toBe(0)
		expect(searchMetrics.internetArchiveSearchRequests).toBeGreaterThan(0)
		expect(searchMetrics.librivoxSearchRequests).toBeGreaterThan(0)
		expect(
			await page.evaluate(
				(storageKey) => localStorage.getItem(storageKey),
				SEARCH_PREFERENCES_KEY
			)
		).toBe(
			JSON.stringify({
				contentPolicyAcknowledgedVersion: null,
				enabledOptionalProviderIds: [],
			})
		)

		await page.getByRole('link', { name: 'Search settings' }).click()
		await expect(
			page.getByRole('heading', {
				exact: true,
				name: 'Audiobook search sources',
			})
		).toBeVisible()
		const trackerCheckbox = page.getByRole('checkbox', {
			name: 'AudioBookBay',
		})
		await expect(trackerCheckbox).not.toBeChecked()
		await expect(
			page.getByText('Use only authorized content', { exact: true }).first()
		).toBeVisible()

		await trackerCheckbox.click()
		let policyDialog = page.getByRole('dialog')
		await expect(policyDialog).toContainText(
			'Enable an unverified third-party source?'
		)
		await expect(policyDialog).toContainText(
			'Never download or share a copyrighted audiobook through a torrent unless'
		)
		await expect(policyDialog).toContainText(
			'Torrent transfers may automatically upload pieces'
		)
		await expect(trackerCheckbox).not.toBeChecked()
		await expect(
			policyDialog.getByRole('button', {
				exact: true,
				name: 'I understand — enable',
			})
		).toBeDisabled()
		await policyDialog
			.getByRole('button', { exact: true, name: 'Cancel' })
			.click()
		await expect(policyDialog).toHaveCount(0)
		await expect(trackerCheckbox).not.toBeChecked()
		searchMetrics = await readJson<SearchUpstreamMetrics>(
			await page.request.get('/__e2e/search-metrics')
		)
		expect(searchMetrics.audiobookBaySearchRequests).toBe(0)
		await page.reload()
		await expect(trackerCheckbox).not.toBeChecked()

		await page.evaluate((storageKey) => {
			const setItem = localStorage.setItem.bind(localStorage)
			Object.defineProperty(localStorage, 'setItem', {
				configurable: true,
				value: (key: string, value: string): void => {
					if (key === storageKey) {
						throw new DOMException(
							'Storage is unavailable',
							'QuotaExceededError'
						)
					}
					setItem(key, value)
				},
			})
		}, SEARCH_PREFERENCES_KEY)
		await trackerCheckbox.click()
		policyDialog = page.getByRole('dialog')
		await policyDialog
			.getByRole('checkbox', {
				name: TRACKER_ACKNOWLEDGEMENT_PATTERN,
			})
			.check()
		await policyDialog
			.getByRole('button', {
				exact: true,
				name: 'I understand — enable',
			})
			.click()
		await expect(policyDialog).toHaveCount(0)
		await expect(
			page
				.getByRole('alert')
				.getByText('Unable to save search settings in this browser', {
					exact: true,
				})
		).toBeVisible()
		await expect(trackerCheckbox).not.toBeChecked()
		await page.evaluate(() => {
			Reflect.deleteProperty(localStorage, 'setItem')
		})

		await trackerCheckbox.click()
		policyDialog = page.getByRole('dialog')
		await policyDialog
			.getByRole('checkbox', {
				name: TRACKER_ACKNOWLEDGEMENT_PATTERN,
			})
			.check()
		await policyDialog
			.getByRole('button', {
				exact: true,
				name: 'I understand — enable',
			})
			.click()
		await expect(policyDialog).toHaveCount(0)
		await expect(trackerCheckbox).toBeChecked()
		expect(
			await page.evaluate(
				(storageKey) => JSON.parse(localStorage.getItem(storageKey) ?? 'null'),
				SEARCH_PREFERENCES_KEY
			)
		).toEqual({
			contentPolicyAcknowledgedVersion: CONTENT_USE_POLICY_VERSION,
			enabledOptionalProviderIds: ['audiobook-bay'],
		})
		await page.reload()
		await expect(
			page.getByRole('checkbox', { name: 'AudioBookBay' })
		).toBeChecked()

		await page.getByRole('link', { name: BACK_TO_LIBRARY_PATTERN }).click()
		await searchbox.fill('private swarm')
		await page.getByRole('button', { exact: true, name: 'search' }).click()
		await expect(
			page.getByRole('heading', {
				exact: true,
				name: 'Unverified third-party results',
			})
		).toBeVisible()
		await expect(
			page.getByText('Rights status is unverified.', { exact: false })
		).toBeVisible()
		await expect(page.getByText('AudioBookBay', { exact: true })).toBeVisible()
		searchMetrics = await readJson<SearchUpstreamMetrics>(
			await page.request.get('/__e2e/search-metrics')
		)
		expect(searchMetrics.audiobookBaySearchRequests).toBe(1)

		await searchbox.fill('archive outage')
		await page.getByRole('button', { exact: true, name: 'search' }).click()
		await expect(
			page.getByText('Some sources could not be searched.', { exact: true })
		).toBeVisible()
		await expect(
			page.getByText(
				'Internet Archive: Internet Archive is temporarily unavailable',
				{ exact: true }
			)
		).toBeVisible()
		await expect(page.getByText('LibriVox', { exact: true })).toBeVisible()

		await searchbox.fill('private swarm')
		await page.getByRole('button', { exact: true, name: 'search' }).click()
		const trackerResults = page.locator('section').filter({
			has: page.getByRole('heading', {
				exact: true,
				name: 'Unverified third-party results',
			}),
		})
		const trackerMetricsBeforeOpen = await readJson<RegistrationMetrics>(
			await page.request.get('/__e2e/registration-metrics')
		)
		searchMetrics = await readJson<SearchUpstreamMetrics>(
			await page.request.get('/__e2e/search-metrics')
		)
		const trackerDetailsBeforeOpen = searchMetrics.audiobookBayDetailRequests
		await trackerResults
			.getByRole('button', { name: OPEN_TRACKER_RESULT_PATTERN })
			.click()
		let actionDialog = page.getByRole('dialog')
		await expect(actionDialog).toContainText(
			'Open an unverified tracker result?'
		)
		await expect(actionDialog).toContainText(
			'Owning a physical or digital copy, or having a subscription, does not by itself authorize'
		)
		await expect(
			actionDialog.getByRole('button', {
				exact: true,
				name: 'I am authorized — continue',
			})
		).toBeDisabled()
		await actionDialog
			.getByRole('button', { exact: true, name: 'Cancel' })
			.click()
		await expect(actionDialog).toHaveCount(0)
		let registrationMetrics = await readJson<RegistrationMetrics>(
			await page.request.get('/__e2e/registration-metrics')
		)
		searchMetrics = await readJson<SearchUpstreamMetrics>(
			await page.request.get('/__e2e/search-metrics')
		)
		expect(registrationMetrics.searchResolveRequests).toBe(
			trackerMetricsBeforeOpen.searchResolveRequests
		)
		expect(searchMetrics.audiobookBayDetailRequests).toBe(
			trackerDetailsBeforeOpen
		)

		await trackerResults
			.getByRole('button', { name: OPEN_TRACKER_RESULT_PATTERN })
			.click()
		actionDialog = page.getByRole('dialog')
		await actionDialog
			.getByRole('checkbox', {
				name: AUTHORIZATION_CHECKBOX_PATTERN,
			})
			.check()
		await actionDialog
			.getByRole('button', {
				exact: true,
				name: 'I am authorized — continue',
			})
			.click()
		await expect(page).toHaveURL(new RegExp(`/playlist/${fixture.infoHash}$`), {
			timeout: 30_000,
		})
		searchMetrics = await readJson<SearchUpstreamMetrics>(
			await page.request.get('/__e2e/search-metrics')
		)
		registrationMetrics = await readJson<RegistrationMetrics>(
			await page.request.get('/__e2e/registration-metrics')
		)
		expect(searchMetrics.audiobookBayDetailRequests).toBe(
			trackerDetailsBeforeOpen + 1
		)
		expect(registrationMetrics.searchResolveRequests).toBe(
			trackerMetricsBeforeOpen.searchResolveRequests + 1
		)

		await page.getByRole('link', { name: BACK_TO_LIBRARY_PATTERN }).click()
		await searchbox.fill('private swarm')
		await page.getByRole('button', { exact: true, name: 'search' }).click()
		const freeResults = page.locator('section').filter({
			has: page.getByRole('heading', {
				exact: true,
				name: 'Public-domain and rights-labelled audiobooks',
			}),
		})
		await expect(page.getByRole('dialog')).toHaveCount(0)
		await freeResults
			.getByRole('button', { name: OPEN_LIBRIVOX_RESULT_PATTERN })
			.click()
		await expect(page).toHaveURL(new RegExp(`/playlist/${fixture.infoHash}$`), {
			timeout: 30_000,
		})
		await expect(page.getByText(fixture.name, { exact: true })).toBeVisible()
		searchMetrics = await readJson<SearchUpstreamMetrics>(
			await page.request.get('/__e2e/search-metrics')
		)
		expect(searchMetrics.archiveMetadataRequests).toBe(1)
	})

	await test.step('direct magnets send no registration request until authorization is confirmed', async () => {
		await page.goto('/')
		const registrationMetricsBefore = await readJson<RegistrationMetrics>(
			await page.request.get('/__e2e/registration-metrics')
		)
		const directSearchbox = page.getByPlaceholder(
			'audiobook title or authorized magnet link'
		)
		await directSearchbox.fill(fixture.magnetUri)
		await page.getByRole('button', { exact: true, name: 'search' }).click()
		let actionDialog = page.getByRole('dialog')
		await expect(actionDialog).toContainText(
			'Open an unverified peer-to-peer source?'
		)
		await actionDialog
			.getByRole('button', { exact: true, name: 'Cancel' })
			.click()
		await expect(actionDialog).toHaveCount(0)
		await expect(directSearchbox).toHaveValue(fixture.magnetUri)
		let registrationMetrics = await readJson<RegistrationMetrics>(
			await page.request.get('/__e2e/registration-metrics')
		)
		expect(registrationMetrics.torrentRegistrationRequests).toBe(
			registrationMetricsBefore.torrentRegistrationRequests
		)

		await page.getByRole('button', { exact: true, name: 'search' }).click()
		actionDialog = page.getByRole('dialog')
		await actionDialog
			.getByRole('checkbox', {
				name: AUTHORIZATION_CHECKBOX_PATTERN,
			})
			.check()
		await actionDialog
			.getByRole('button', {
				exact: true,
				name: 'I am authorized — continue',
			})
			.click()
		await expect(page).toHaveURL(new RegExp(`/playlist/${fixture.infoHash}$`), {
			timeout: 30_000,
		})
		registrationMetrics = await readJson<RegistrationMetrics>(
			await page.request.get('/__e2e/registration-metrics')
		)
		expect(registrationMetrics.torrentRegistrationRequests).toBe(
			registrationMetricsBefore.torrentRegistrationRequests + 1
		)
		await expect(page.getByText(fixture.name, { exact: true })).toBeVisible()
		await Promise.all(
			fixture.files.map(async (file) => {
				await expect(page.getByText(file.path, { exact: true })).toBeVisible()
			})
		)
	})

	await test.step('one click selects a direct range-backed audio source and playback advances', async () => {
		const rangeResponse = page.waitForResponse(
			(candidateResponse) =>
				candidateResponse.url().includes('/files/') &&
				candidateResponse.status() === 206,
			{ timeout: 30_000 }
		)
		await page
			.getByRole('button', { name: new RegExp(firstAudio?.name ?? '^$') })
			.click()
		await page.getByRole('button', { exact: true, name: 'Play' }).click()
		const response = await rangeResponse
		expect(response.request().headers().range).toMatch(BYTE_RANGE_PATTERN)
		expect(response.headers()['content-range']).toMatch(CONTENT_RANGE_PATTERN)
		await expect(
			page.getByRole('button', { exact: true, name: 'Stop' })
		).toBeVisible()

		const slider = page.getByRole('slider')
		await expect
			.poll(async () => Number(await slider.getAttribute('aria-valuemax')), {
				timeout: 20_000,
			})
			.toBeGreaterThan(30)
		await expect
			.poll(async () => Number(await slider.getAttribute('aria-valuenow')), {
				timeout: 20_000,
			})
			.toBeGreaterThan(0)
		await page.getByRole('button', { exact: true, name: 'Stop' }).click()

		await expect
			.poll(
				async () => {
					const metrics = await readJson<TransferMetrics>(
						await page.request.get('/__e2e/metrics')
					)
					return Math.min(
						metrics.downloaderDownloadedBytes,
						metrics.seederUploadedBytes
					)
				},
				{ timeout: 10_000 }
			)
			.toBeGreaterThan(32 * 1024)
		const metrics = await readJson<TransferMetrics>(
			await page.request.get('/__e2e/metrics')
		)
		expect(
			metrics.fileRequests.some(
				(request) =>
					request.status === 206 && request.range?.startsWith('bytes=')
			)
		).toBe(true)
	})

	await test.step('the UI starts a server preload that downloads exact torrent bytes', async () => {
		await openAction(page, 'Preload')
		await confirmAction(page, 'Preload book?', AUTHORIZED_UPLOAD_PATTERN)
		await expect
			.poll(
				async () => {
					const response = await page.request.get(
						`/api/torrents/${fixture.infoHash}/preload`
					)
					if (!response.ok()) {
						return null
					}
					return ((await response.json()) as PreloadStatus).state
				},
				{ timeout: 30_000 }
			)
			.toBe('completed')
		const status = await readJson<PreloadStatus>(
			await page.request.get(`/api/torrents/${fixture.infoHash}/preload`)
		)
		expect(status.downloadedBytes).toBe(fixture.totalBytes)
		expect(status.totalBytes).toBe(fixture.totalBytes)
	})

	await test.step('explicit download stores every real file in IndexedDB', async () => {
		await openAction(page, 'Download All')
		await confirmAction(page, 'Download all files?', AUTHORIZED_UPLOAD_PATTERN)
		await expect
			.poll(async () => await getCachedFileCount(page, fixture.infoHash), {
				timeout: 30_000,
			})
			.toBe(fixture.files.length)
		await expect(page.getByText('loaded', { exact: true })).toHaveCount(
			fixture.files.length
		)

		const slider = page.getByRole('slider')
		const bounds = await slider.boundingBox()
		expect(bounds).not.toBeNull()
		if (!bounds) {
			throw new Error('The playback slider has no visible bounds')
		}
		await slider.click({
			position: { x: bounds.width * 0.25, y: bounds.height / 2 },
		})
		await page.getByRole('button', { exact: true, name: 'Play' }).click()
		await page.waitForTimeout(500)
		await page.getByRole('button', { exact: true, name: 'Stop' }).click()
		await expect
			.poll(async () => await getSavedPlaybackTime(page, fixture.infoHash), {
				timeout: 10_000,
			})
			.toBeGreaterThan(10)
	})

	await test.step('reload resumes from IndexedDB while every file-network request is blocked', async () => {
		let blockedFileRequests = 0
		await page.route('**/api/torrents/*/files/*', async (route) => {
			blockedFileRequests += 1
			await route.abort('failed')
		})
		await page.reload()
		await expect(page.getByText(fixture.name, { exact: true })).toBeVisible()
		await expect(page.getByText('loaded', { exact: true })).toHaveCount(
			fixture.files.length
		)
		await expect
			.poll(
				async () =>
					Number(await page.getByRole('slider').getAttribute('aria-valuenow')),
				{ timeout: 20_000 }
			)
			.toBeGreaterThan(10)
		await page.getByRole('button', { exact: true, name: 'Play' }).click()
		await expect(
			page.getByRole('button', { exact: true, name: 'Stop' })
		).toBeVisible()
		await page.waitForTimeout(500)
		expect(blockedFileRequests).toBe(0)
		await page.getByRole('button', { exact: true, name: 'Stop' }).click()
		await page.unroute('**/api/torrents/*/files/*')
	})

	await test.step('history appears in both the local library and server list', async () => {
		await page.getByRole('link', { name: BACK_TO_LIBRARY_PATTERN }).click()
		await expect(page.getByText('Recent', { exact: true })).toBeVisible()
		await expect(
			page.getByText(fixture.name, { exact: true }).first()
		).toBeVisible()
		await page
			.getByRole('button', {
				exact: true,
				name: 'Show books available on server',
			})
			.click()
		await expect(
			page.getByText('Available Books', { exact: true })
		).toBeVisible()
		await expect(page.getByText(fixture.name, { exact: true })).toHaveCount(2)
	})

	await test.step('clean removes offline bytes but keeps the book, then remove clears the local library', async () => {
		await page.getByText(fixture.name, { exact: true }).first().click()
		await expect(page).toHaveURL(new RegExp(`/playlist/${fixture.infoHash}$`))
		await page.getByRole('button', { exact: true, name: 'Actions' }).click()
		await page.getByRole('button', { name: CLEAN_BOOK_PATTERN }).last().click()
		await confirmAction(page, 'Clean book data?')
		await expect
			.poll(async () => await getCachedFileCount(page, fixture.infoHash), {
				timeout: 10_000,
			})
			.toBe(0)
		await expect(page.getByText('loaded', { exact: true })).toHaveCount(0)

		await page
			.getByRole('button', { exact: true, name: 'Remove Book from Library' })
			.last()
			.click()
		await confirmAction(page, 'Remove book?')
		await expect(page).toHaveURL('/')
		await page.reload()
		await expect(
			page.getByText('No books in library', { exact: true })
		).toBeVisible()
	})

	await test.step('server deletion clears its history and cached torrent', async () => {
		await page
			.getByRole('button', {
				exact: true,
				name: 'Show books available on server',
			})
			.click()
		await expect(page.getByText(fixture.name, { exact: true })).toBeVisible()
		page.once('dialog', async (dialog) => {
			await dialog.accept()
		})
		await page.getByRole('button', { exact: true, name: 'Delete' }).click()
		await expect(
			page.getByText('No books available on server', { exact: true })
		).toBeVisible()
		const available = await readJson<unknown[]>(
			await page.request.get('/api/torrents')
		)
		expect(available).toEqual([])
	})

	expect(pageErrors).toEqual([])
})

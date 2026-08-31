import { type APIResponse, expect, type Page, test } from '@playwright/test'
import { CONTENT_USE_POLICY_VERSION } from '../src/search/contentPolicy'
import { SEARCH_PREFERENCES_KEY } from '../src/search/preferences'

const BACK_TO_LIBRARY_PATTERN = /Back to library/
const AUTHORIZATION_CHECKBOX_PATTERN = /I confirm that I am legally authorized/
const AUTHORIZED_UPLOAD_PATTERN = /authorized.+upload pieces/s
const AUDIO_FILE_PATH_PATTERN = /\.(?:m4a|m4b|mp3|ogg|opus|wav)$/i
const BACKWARD_JUMP_LABEL_PATTERN = /^Back \d+ seconds$/
const BYTE_RANGE_PATTERN = /^bytes=/
const CACHE_CHUNK_BYTES = 1024 * 1024
const CLEAR_OFFLINE_PATTERN = /^Clear offline data \(/
const CONTENT_RANGE_PATTERN = /^bytes 0-/
const FRESH_FRONTEND_CACHE_CONTROL = 'no-cache, no-store, must-revalidate'
const HASHED_SCRIPT_PATH_PATTERN = /^\/assets\/.+\.js$/
const HASHED_SCRIPT_PATTERN = /<script[^>]+src="(\/assets\/[^"]+\.js)"/
const IMMUTABLE_ASSET_CACHE_CONTROL = 'public, max-age=31536000, immutable'
const JUMP_TIME_PATTERN = /^\d+$/
const OFFLINE_CACHE_PURPOSE = 'offline-cache'
const OPEN_LIBRIVOX_RESULT_PATTERN = /^Open .+ from LibriVox$/
const OPEN_TRACKER_RESULT_PATTERN = /^Open .+ from AudioBookBay$/
const FORWARD_JUMP_LABEL_PATTERN = /^Forward \d+ seconds$/
const PLAYBACK_START_SAMPLES_KEY = '__tplayerPlaybackStartSamples'
const TIME_LABEL_PATTERN = /^\d+:\d{2}$/
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
	pathname: string
	purpose: string | null
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

interface TorrentSummary {
	cachedBytes: number
	infoHash: string
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

const getCachedFileBytes = async (
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
				const transaction = database.transaction(
					['fileDownloads', 'files'],
					'readonly'
				)
				const filesRequest = transaction
					.objectStore('files')
					.index('ih')
					.getAll(hash)
				const downloadsRequest = transaction
					.objectStore('fileDownloads')
					.index('ih')
					.getAll(hash)
				const [files, downloads] = await Promise.all([
					new Promise<Array<{ file?: Blob; length?: number }>>(
						(resolve, reject) => {
							filesRequest.onerror = () => reject(filesRequest.error)
							filesRequest.onsuccess = () =>
								resolve(
									filesRequest.result as Array<{
										file?: Blob
										length?: number
									}>
								)
						}
					),
					new Promise<Array<{ downloadedBytes?: number }>>(
						(resolve, reject) => {
							downloadsRequest.onerror = () => reject(downloadsRequest.error)
							downloadsRequest.onsuccess = () =>
								resolve(
									downloadsRequest.result as Array<{
										downloadedBytes?: number
									}>
								)
						}
					),
				])
				const completeBytes = files.reduce(
					(totalBytes, record) =>
						totalBytes + (record.length ?? record.file?.size ?? 0),
					0
				)
				return downloads.reduce(
					(totalBytes, record) => totalBytes + (record.downloadedBytes ?? 0),
					completeBytes
				)
			} finally {
				database.close()
			}
		},
		{ databaseName: 'books', hash: infoHash }
	)

const getCachedFileSha256 = async (
	page: Page,
	infoHash: string,
	path: string
): Promise<string | null> =>
	await page.evaluate(
		async ({ databaseName, hash, requestedPath }) => {
			const database = await new Promise<IDBDatabase>((resolve, reject) => {
				const request = indexedDB.open(databaseName)
				request.onerror = () => reject(request.error)
				request.onsuccess = () => resolve(request.result)
			})
			try {
				const transaction = database.transaction(
					['fileChunks', 'files'],
					'readonly'
				)
				const fileRequest = transaction
					.objectStore('files')
					.get([hash, requestedPath])
				const chunksRequest = transaction
					.objectStore('fileChunks')
					.index('[ih+path]')
					.getAll([hash, requestedPath])
				const [record, chunks] = await Promise.all([
					new Promise<{ file?: Blob; storage?: string } | undefined>(
						(resolve, reject) => {
							fileRequest.onerror = () => reject(fileRequest.error)
							fileRequest.onsuccess = () =>
								resolve(
									fileRequest.result as
										| { file?: Blob; storage?: string }
										| undefined
								)
						}
					),
					new Promise<Array<{ data: Blob; index: number }>>(
						(resolve, reject) => {
							chunksRequest.onerror = () => reject(chunksRequest.error)
							chunksRequest.onsuccess = () =>
								resolve(
									chunksRequest.result as Array<{
										data: Blob
										index: number
									}>
								)
						}
					),
				])
				if (!record) {
					return null
				}
				let { file } = record
				if (!(file instanceof Blob)) {
					chunks.sort((left, right) => left.index - right.index)
					file = new Blob(chunks.map(({ data }) => data))
				}
				const hashBytes = new Uint8Array(
					await crypto.subtle.digest('SHA-256', await file.arrayBuffer())
				)
				let hexadecimal = ''
				for (const byte of hashBytes) {
					hexadecimal += byte.toString(16).padStart(2, '0')
				}
				return hexadecimal
			} finally {
				database.close()
			}
		},
		{ databaseName: 'books', hash: infoHash, requestedPath: path }
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
	const closeActions = page.getByRole('button', {
		exact: true,
		name: 'Close actions',
	})
	if (await closeActions.isVisible()) {
		await closeActions.click()
	}
}

const authorizeDirectTorrentAccess = async (page: Page): Promise<void> => {
	const dialog = page.getByRole('dialog')
	await expect(dialog).toContainText('Open an unverified peer-to-peer source?')
	await dialog
		.getByRole('checkbox', {
			name: AUTHORIZATION_CHECKBOX_PATTERN,
		})
		.check()
	await dialog
		.getByRole('button', {
			exact: true,
			name: 'I am authorized — continue',
		})
		.click()
	await expect(dialog).toHaveCount(0)
}

test.afterAll(async ({ request }) => {
	const response = await request.post('/__e2e/cleanup')
	expect(response.status()).toBe(204)
})

test('production shell and service worker stay fresh while hashed assets remain immutable', async ({
	request,
}) => {
	const shellResponse = await request.get('/')
	const shell = await shellResponse.text()
	expect(shellResponse.ok(), shell).toBe(true)
	expect(shellResponse.headers()['cache-control']).toBe(
		FRESH_FRONTEND_CACHE_CONTROL
	)
	const scriptPath = HASHED_SCRIPT_PATTERN.exec(shell)?.[1] ?? ''
	expect(scriptPath).toMatch(HASHED_SCRIPT_PATH_PATTERN)

	const [apiResponse, fallbackResponse, scriptResponse, serviceWorkerResponse] =
		await Promise.all([
			request.get('/api/health'),
			request.get('/playlist/cache-policy-probe'),
			request.get(scriptPath),
			request.get('/sw.js'),
		])
	expect(apiResponse.ok(), await apiResponse.text()).toBe(true)
	expect(apiResponse.headers()['cache-control']).toBe('private, no-store')
	const fallbackShell = await fallbackResponse.text()
	expect(fallbackResponse.ok(), fallbackShell).toBe(true)
	expect(fallbackResponse.headers()['cache-control']).toBe(
		FRESH_FRONTEND_CACHE_CONTROL
	)
	expect(fallbackShell).toContain(scriptPath)
	expect(scriptResponse.ok(), await scriptResponse.text()).toBe(true)
	expect(scriptResponse.headers()['cache-control']).toBe(
		IMMUTABLE_ASSET_CACHE_CONTROL
	)
	expect(serviceWorkerResponse.ok(), await serviceWorkerResponse.text()).toBe(
		true
	)
	expect(serviceWorkerResponse.headers()['cache-control']).toBe(
		FRESH_FRONTEND_CACHE_CONTROL
	)
})

test('a full browser quota keeps real range playback online without starting an offline transfer', async ({
	page,
}) => {
	await page.addInitScript(() => {
		const mebibyte = 1024 * 1024
		Object.defineProperty(navigator, 'storage', {
			configurable: true,
			value: {
				estimate: () =>
					Promise.resolve({ quota: 10 * mebibyte, usage: 9 * mebibyte }),
				persist: () => Promise.resolve(false),
			},
		})
	})
	const fixture = await readJson<FixtureDescriptor>(
		await page.request.get('/__e2e/fixture')
	)
	const firstAudio = fixture.files.find((file) => file.name.startsWith('01 -'))
	expect(firstAudio).toBeDefined()
	const registration = await page.request.post('/api/torrents', {
		data: { torrentId: fixture.magnetUri },
	})
	expect(registration.ok(), await registration.text()).toBe(true)
	const metricsBefore = await readJson<TransferMetrics>(
		await page.request.get('/__e2e/metrics')
	)

	await page.goto(`/playlist/${fixture.infoHash}`)
	await authorizeDirectTorrentAccess(page)
	await expect(page.getByText(fixture.name, { exact: true })).toBeVisible()
	const playbackRange = page.waitForResponse(
		(response) =>
			response.url().includes('/files/') &&
			response.status() === 206 &&
			response.request().headers()['x-tplayer-purpose'] === undefined,
		{ timeout: 30_000 }
	)
	const currentFileRow = page.getByRole('button', {
		name: new RegExp(firstAudio?.name ?? '^$'),
	})
	await currentFileRow.click()
	const backwardButton = page.getByRole('button', {
		name: BACKWARD_JUMP_LABEL_PATTERN,
	})
	const forwardButton = page.getByRole('button', {
		name: FORWARD_JUMP_LABEL_PATTERN,
	})
	const jumpTime = await backwardButton.innerText()
	expect(jumpTime).toMatch(JUMP_TIME_PATTERN)
	await expect(forwardButton).toHaveText(jumpTime)
	const playbackSlider = page.getByRole('slider', {
		name: 'Playback position',
	})
	await expect
		.poll(
			async () => Number(await playbackSlider.getAttribute('aria-valuemax')),
			{ timeout: 20_000 }
		)
		.toBeGreaterThan(30)
	const sliderBounds = await playbackSlider.boundingBox()
	expect(sliderBounds).not.toBeNull()
	if (!sliderBounds) {
		throw new Error('The playback slider has no visible bounds')
	}
	const sliderY = sliderBounds.y + sliderBounds.height / 2
	await page.mouse.move(sliderBounds.x + sliderBounds.width * 0.2, sliderY)
	await page.mouse.down()
	await page.mouse.move(sliderBounds.x + sliderBounds.width * 0.6, sliderY, {
		steps: 8,
	})
	const seekPreview = page.getByTestId('seek-preview')
	await expect(seekPreview).toBeVisible()
	await expect(seekPreview).toHaveText(TIME_LABEL_PATTERN)
	const duration = Number(await playbackSlider.getAttribute('aria-valuemax'))
	expect(
		Number(await playbackSlider.getAttribute('aria-valuenow'))
	).toBeGreaterThan(duration * 0.5)
	await page.mouse.up()
	await expect(seekPreview).toHaveCount(0)
	await expect
		.poll(async () =>
			Number(await playbackSlider.getAttribute('aria-valuenow'))
		)
		.toBeGreaterThan(duration * 0.5)
	const positionBeforeTouch = Number(
		await playbackSlider.getAttribute('aria-valuenow')
	)
	const browserSession = await page.context().newCDPSession(page)
	await browserSession.send('Emulation.setTouchEmulationEnabled', {
		enabled: true,
		maxTouchPoints: 1,
	})
	const touchStartX = Math.round(sliderBounds.x + sliderBounds.width * 0.9)
	const touchActivationX = Math.round(touchStartX - sliderBounds.width * 0.1)
	const touchMoveX = Math.round(touchActivationX - sliderBounds.width * 0.1)
	const touchY = Math.round(sliderY)
	await browserSession.send('Input.dispatchTouchEvent', {
		touchPoints: [{ x: touchStartX, y: touchY }],
		type: 'touchStart',
	})
	await expect(seekPreview).toBeVisible()
	expect(
		Math.abs(
			Number(await playbackSlider.getAttribute('aria-valuenow')) -
				positionBeforeTouch
		)
	).toBeLessThan(duration * 0.01)
	await browserSession.send('Input.dispatchTouchEvent', {
		touchPoints: [{ x: touchActivationX, y: touchY }],
		type: 'touchMove',
	})
	await playbackSlider.evaluate(
		() =>
			new Promise((resolve) => {
				requestAnimationFrame(() => requestAnimationFrame(resolve))
			})
	)
	expect(
		Math.abs(
			Number(await playbackSlider.getAttribute('aria-valuenow')) -
				positionBeforeTouch
		)
	).toBeLessThan(duration * 0.01)
	await browserSession.send('Input.dispatchTouchEvent', {
		touchPoints: [{ x: touchMoveX, y: touchY }],
		type: 'touchMove',
	})
	await expect
		.poll(async () =>
			Number(await playbackSlider.getAttribute('aria-valuenow'))
		)
		.toBeLessThan(positionBeforeTouch - duration * 0.05)
	await browserSession.send('Input.dispatchTouchEvent', {
		touchPoints: [],
		type: 'touchEnd',
	})
	await expect(seekPreview).toHaveCount(0)
	await browserSession.send('Emulation.setTouchEmulationEnabled', {
		enabled: false,
	})
	await browserSession.detach()
	const positionBeforePlay = Number(
		await playbackSlider.getAttribute('aria-valuenow')
	)
	await playbackSlider.evaluate((slider, samplesKey) => {
		const samples = [Number(slider.getAttribute('aria-valuenow'))]
		const observer = new MutationObserver(() => {
			samples.push(Number(slider.getAttribute('aria-valuenow')))
		})
		observer.observe(slider, {
			attributeFilter: ['aria-valuenow'],
			attributes: true,
		})
		Reflect.set(window, samplesKey, samples)
		setTimeout(() => observer.disconnect(), 1500)
	}, PLAYBACK_START_SAMPLES_KEY)
	await page.getByRole('button', { exact: true, name: 'Play' }).click()
	await playbackRange
	await page.waitForTimeout(1000)
	const playbackStartSamples = await page.evaluate((samplesKey) => {
		const samples = Reflect.get(window, samplesKey)
		return Array.isArray(samples) ? samples.map(Number) : []
	}, PLAYBACK_START_SAMPLES_KEY)
	expect(playbackStartSamples.length).toBeGreaterThan(0)
	expect(Math.min(...playbackStartSamples)).toBeGreaterThan(
		positionBeforePlay - 1
	)
	await expect(currentFileRow).toHaveAttribute(
		'data-playback-state',
		'streaming-unavailable'
	)
	await expect(currentFileRow).toContainText('offline storage full')
	await expect
		.poll(
			async () =>
				Number(await page.getByRole('slider').getAttribute('aria-valuenow')),
			{ timeout: 20_000 }
		)
		.toBeGreaterThan(0)
	expect(
		await getCachedFileSha256(page, fixture.infoHash, firstAudio?.path ?? '')
	).toBeNull()
	const metricsAfter = await readJson<TransferMetrics>(
		await page.request.get('/__e2e/metrics')
	)
	const newRequests = metricsAfter.fileRequests.slice(
		metricsBefore.fileRequests.length
	)
	expect(
		newRequests.some(
			(request) =>
				request.purpose === OFFLINE_CACHE_PURPOSE &&
				request.contentRange?.endsWith(`/${firstAudio?.bytes ?? 0}`)
		)
	).toBe(false)
	await page.getByRole('button', { exact: true, name: 'Pause' }).click()
})

test('a real private torrent plays, persists offline, and follows full lifecycle', async ({
	context,
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
	const lastAudio = fixture.files
		.filter((file) => AUDIO_FILE_PATH_PATTERN.test(file.path))
		.at(-1)
	expect(
		firstAudio,
		'The deterministic swarm must include the first WAV'
	).toBeDefined()
	expect(
		lastAudio,
		'The deterministic swarm must include a final WAV'
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
		await expect(
			page.getByRole('button', { exact: true, name: 'Play' })
		).toBeDisabled()
	})

	await test.step('range playback advances while exact chunks save, then replay stays local', async () => {
		const cachedCountBeforeStreaming = await getCachedFileCount(
			page,
			fixture.infoHash
		)
		const cachedBytesBeforeStreaming = await getCachedFileBytes(
			page,
			fixture.infoHash
		)
		const metricsBeforeStreaming = await readJson<TransferMetrics>(
			await page.request.get('/__e2e/metrics')
		)
		const heldPlaybackRange = await page.request.post('/__e2e/range-delays', {
			data: { offlineCacheRangeMs: 200, playbackRangeMs: 1000 },
		})
		expect(heldPlaybackRange.ok(), await heldPlaybackRange.text()).toBe(true)
		const rangeResponse = page.waitForResponse(
			(candidateResponse) =>
				candidateResponse.url().includes('/files/') &&
				candidateResponse.status() === 206 &&
				candidateResponse.request().headers()['x-tplayer-purpose'] ===
					undefined,
			{ timeout: 30_000 }
		)
		const currentFileRow = page.getByRole('button', {
			name: new RegExp(firstAudio?.name ?? '^$'),
		})
		await currentFileRow.click()
		await page.getByRole('button', { exact: true, name: 'Play' }).click()
		await expect(
			page.getByRole('button', { exact: true, name: 'Pause' })
		).toBeVisible()
		await page.getByRole('button', { exact: true, name: 'Pause' }).click()
		await expect(
			page.getByRole('button', { exact: true, name: 'Play' })
		).toBeVisible()
		const response = await rangeResponse
		expect(response.request().headers().range).toMatch(BYTE_RANGE_PATTERN)
		expect(response.headers()['content-range']).toMatch(CONTENT_RANGE_PATTERN)
		const releasedPlaybackRange = await page.request.post(
			'/__e2e/range-delays',
			{
				data: { offlineCacheRangeMs: 200, playbackRangeMs: 0 },
			}
		)
		expect(releasedPlaybackRange.ok(), await releasedPlaybackRange.text()).toBe(
			true
		)
		await page.getByRole('button', { exact: true, name: 'Play' }).click()
		await expect(
			page.getByRole('button', { exact: true, name: 'Pause' })
		).toBeVisible()

		await expect(currentFileRow).toHaveAttribute('aria-current', 'true')
		await expect(currentFileRow).toHaveAttribute(
			'data-playback-source',
			'server'
		)
		await expect(currentFileRow).toHaveAttribute(
			'data-playback-state',
			'streaming-saving'
		)
		await expect(currentFileRow).toContainText('streaming · saving offline')
		await expect
			.poll(
				async () => {
					const value = Number(
						await currentFileRow.getAttribute('data-offline-progress')
					)
					return value > 0 && value < 100
				},
				{ timeout: 20_000 }
			)
			.toBe(true)
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
		const playbackTimeWhileSaving = Number(
			await slider.getAttribute('aria-valuenow')
		)
		expect(await getCachedFileCount(page, fixture.infoHash)).toBe(
			cachedCountBeforeStreaming
		)
		const partialBytes = await getCachedFileBytes(page, fixture.infoHash)
		expect(partialBytes).toBeGreaterThan(cachedBytesBeforeStreaming)
		expect(partialBytes).toBeLessThan(
			cachedBytesBeforeStreaming + (firstAudio?.bytes ?? 0)
		)

		await expect(currentFileRow).toHaveAttribute(
			'data-playback-state',
			'streaming-cached',
			{ timeout: 30_000 }
		)
		await expect(currentFileRow).toContainText('streaming · available offline')
		await expect
			.poll(async () => await getCachedFileCount(page, fixture.infoHash), {
				timeout: 30_000,
			})
			.toBe(cachedCountBeforeStreaming + 1)
		expect(await getCachedFileBytes(page, fixture.infoHash)).toBe(
			cachedBytesBeforeStreaming + (firstAudio?.bytes ?? 0)
		)
		expect(
			await getCachedFileSha256(page, fixture.infoHash, firstAudio?.path ?? '')
		).toBe(firstAudio?.sha256)
		await expect
			.poll(async () => Number(await slider.getAttribute('aria-valuenow')))
			.toBeGreaterThan(playbackTimeWhileSaving)

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
		const metricsAfterStreaming = await readJson<TransferMetrics>(
			await page.request.get('/__e2e/metrics')
		)
		const newRequests = metricsAfterStreaming.fileRequests.slice(
			metricsBeforeStreaming.fileRequests.length
		)
		const selectedCacheRanges = newRequests.filter(
			(request) =>
				request.purpose === OFFLINE_CACHE_PURPOSE &&
				request.contentRange?.endsWith(`/${firstAudio?.bytes ?? 0}`)
		)
		const expectedChunkCount = Math.ceil(
			(firstAudio?.bytes ?? 0) / CACHE_CHUNK_BYTES
		)
		expect(selectedCacheRanges).toHaveLength(expectedChunkCount)
		expect(new Set(selectedCacheRanges.map(({ range }) => range)).size).toBe(
			expectedChunkCount
		)
		for (let index = 0; index < expectedChunkCount; index += 1) {
			const start = index * CACHE_CHUNK_BYTES
			const end = Math.min(
				(firstAudio?.bytes ?? 0) - 1,
				start + CACHE_CHUNK_BYTES - 1
			)
			const request = selectedCacheRanges[index]
			expect(request?.method).toBe('GET')
			expect(request?.range).toBe(`bytes=${start}-${end}`)
			expect(request?.status).toBe(206)
			expect(request?.contentLength).toBe(end - start + 1)
		}
		expect(
			newRequests.some(
				(request) =>
					request.purpose === null &&
					request.status === 206 &&
					request.contentRange?.endsWith(`/${firstAudio?.bytes ?? 0}`)
			)
		).toBe(true)

		await page.getByRole('button', { exact: true, name: 'Pause' }).click()
		await expect(currentFileRow).toHaveAttribute(
			'data-playback-source',
			'offline'
		)
		const savedPosition = Number(await slider.getAttribute('aria-valuenow'))
		let blockedFileRequests = 0
		await page.route('**/api/torrents/*/files/*', async (route) => {
			blockedFileRequests += 1
			await route.abort('failed')
		})
		await page.getByRole('button', { exact: true, name: 'Play' }).click()
		await expect(currentFileRow).toHaveAttribute(
			'data-playback-state',
			'playing-offline'
		)
		await expect
			.poll(async () => Number(await slider.getAttribute('aria-valuenow')), {
				timeout: 20_000,
			})
			.toBeGreaterThan(savedPosition)
		expect(blockedFileRequests).toBe(0)
		await page.getByRole('button', { exact: true, name: 'Pause' }).click()
		await page.unroute('**/api/torrents/*/files/*')
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
		const summaries = await readJson<TorrentSummary[]>(
			await page.request.get('/api/torrents')
		)
		const summary = summaries.find(
			(torrent) => torrent.infoHash === fixture.infoHash
		)
		expect(summary?.cachedBytes).toBeGreaterThan(0)
		await expect(page.locator('[data-server-cache-bytes]')).toHaveAttribute(
			'data-server-cache-bytes',
			String(summary?.cachedBytes)
		)
		await expect(page.getByText('Server cache', { exact: true })).toBeVisible()
		const offlineBytes = await getCachedFileBytes(page, fixture.infoHash)
		await expect(page.locator('[data-offline-bytes]')).toHaveAttribute(
			'data-offline-bytes',
			String(offlineBytes)
		)
	})

	await test.step('clearing an active bulk save stops later files, then a retry stores every real file', async () => {
		await page.getByRole('button', { exact: true, name: 'Show cover' }).click()
		await expect(
			page.getByRole('img', { exact: true, name: `${fixture.name} cover` })
		).toBeVisible()
		const metricsBeforeInterruptedBulk = await readJson<TransferMetrics>(
			await page.request.get('/__e2e/metrics')
		)
		await openAction(page, 'Download All')
		await confirmAction(page, 'Download all files?', AUTHORIZED_UPLOAD_PATTERN)
		await expect(
			page.locator('[data-playback-state="saving"]').first()
		).toBeVisible({
			timeout: 10_000,
		})
		await page.getByRole('button', { exact: true, name: 'Actions' }).click()
		await page
			.getByRole('button', { name: CLEAR_OFFLINE_PATTERN })
			.last()
			.click()
		await confirmAction(page, 'Clear offline data?')
		await expect
			.poll(async () => await getCachedFileBytes(page, fixture.infoHash), {
				timeout: 10_000,
			})
			.toBe(0)
		const metricsWhenBulkWasCleared = await readJson<TransferMetrics>(
			await page.request.get('/__e2e/metrics')
		)
		expect(
			metricsWhenBulkWasCleared.fileRequests
				.slice(metricsBeforeInterruptedBulk.fileRequests.length)
				.some((request) => request.purpose === OFFLINE_CACHE_PURPOSE)
		).toBe(true)
		await page.waitForTimeout(750)
		expect(await getCachedFileBytes(page, fixture.infoHash)).toBe(0)
		const metricsAfterBulkSettled = await readJson<TransferMetrics>(
			await page.request.get('/__e2e/metrics')
		)
		expect(
			metricsAfterBulkSettled.fileRequests
				.slice(metricsWhenBulkWasCleared.fileRequests.length)
				.filter((request) => request.purpose === OFFLINE_CACHE_PURPOSE)
		).toEqual([])
		await expect(page.locator('[data-playback-state="saving"]')).toHaveCount(0)

		const crossTabFileRow = page.getByRole('button', {
			name: new RegExp(firstAudio?.name ?? '^$'),
		})
		const heldCacheRanges = await page.request.post('/__e2e/range-delays', {
			data: { offlineCacheRangeMs: 1000, playbackRangeMs: 0 },
		})
		expect(heldCacheRanges.ok(), await heldCacheRanges.text()).toBe(true)
		await crossTabFileRow.click()
		await expect(crossTabFileRow).toContainText('saving offline')
		await expect(crossTabFileRow).toHaveAttribute('data-offline-progress', '0')
		await page.getByRole('button', { exact: true, name: 'Actions' }).click()
		await expect(
			page.getByRole('button', { name: CLEAR_OFFLINE_PATTERN }).last()
		).toBeEnabled()
		await page
			.getByRole('button', { exact: true, name: 'Close actions' })
			.click()
		const releasedCacheRanges = await page.request.post('/__e2e/range-delays', {
			data: { offlineCacheRangeMs: 200, playbackRangeMs: 0 },
		})
		expect(releasedCacheRanges.ok(), await releasedCacheRanges.text()).toBe(
			true
		)
		await expect
			.poll(
				async () =>
					Number(await crossTabFileRow.getAttribute('data-offline-progress')),
				{ timeout: 10_000 }
			)
			.toBeGreaterThan(0)
		const clearingPage = await context.newPage()
		await clearingPage.goto(`/playlist/${fixture.infoHash}`)
		await authorizeDirectTorrentAccess(clearingPage)
		await expect(
			clearingPage.getByText(fixture.name, { exact: true })
		).toBeVisible()
		await clearingPage
			.getByRole('button', { exact: true, name: 'Actions' })
			.click()
		await clearingPage
			.getByRole('button', { name: CLEAR_OFFLINE_PATTERN })
			.last()
			.click()
		await confirmAction(clearingPage, 'Clear offline data?')
		await expect
			.poll(async () => await getCachedFileBytes(page, fixture.infoHash), {
				timeout: 10_000,
			})
			.toBe(0)
		await expect(crossTabFileRow).not.toContainText('saving offline')
		await expect(crossTabFileRow).toHaveAttribute('data-offline-progress', '0')
		await clearingPage.close()

		await crossTabFileRow.click()
		await expect(crossTabFileRow).toContainText('saving offline')

		await openAction(page, 'Download All')
		await confirmAction(page, 'Download all files?', AUTHORIZED_UPLOAD_PATTERN)
		await expect
			.poll(async () => await getCachedFileCount(page, fixture.infoHash), {
				timeout: 30_000,
			})
			.toBe(fixture.files.length)
		await expect(
			page.getByText('available offline', { exact: true })
		).toHaveCount(fixture.files.length)
		await expect(page.locator('[data-offline-bytes]')).toHaveAttribute(
			'data-offline-bytes',
			String(fixture.totalBytes)
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
		await page.getByRole('button', { exact: true, name: 'Pause' }).click()
		await expect
			.poll(async () => await getSavedPlaybackTime(page, fixture.infoHash), {
				timeout: 10_000,
			})
			.toBeGreaterThan(10)
	})

	await test.step('a completed final chapter switches to its local copy before replay', async () => {
		const finalFileRow = page.getByRole('button', {
			name: new RegExp(lastAudio?.name ?? '^$'),
		})
		await finalFileRow.locator('..').getByTitle('Delete').click()
		await expect(finalFileRow).not.toContainText('available offline')
		const finalPlaybackRange = page.waitForResponse(
			(response) =>
				response.url().includes('/files/') &&
				response.status() === 206 &&
				response.request().headers()['x-tplayer-purpose'] === undefined,
			{ timeout: 30_000 }
		)
		await finalFileRow.click()
		await page.getByRole('button', { exact: true, name: 'Play' }).click()
		await finalPlaybackRange
		await expect(finalFileRow).toHaveAttribute(
			'data-playback-state',
			'streaming-cached',
			{ timeout: 30_000 }
		)

		const slider = page.getByRole('slider')
		const bounds = await slider.boundingBox()
		expect(bounds).not.toBeNull()
		if (!bounds) {
			throw new Error('The playback slider has no visible bounds')
		}
		await slider.click({
			position: { x: bounds.width * 0.999, y: bounds.height / 2 },
		})
		await expect(
			page.getByRole('button', { exact: true, name: 'Play' })
		).toBeVisible({ timeout: 10_000 })
		await expect(finalFileRow).toHaveAttribute(
			'data-playback-source',
			'offline'
		)

		let blockedReplayRequests = 0
		await page.route('**/api/torrents/*/files/*', async (route) => {
			blockedReplayRequests += 1
			await route.abort('failed')
		})
		await page.getByRole('button', { exact: true, name: 'Play' }).click()
		await expect(finalFileRow).toHaveAttribute(
			'data-playback-state',
			'playing-offline'
		)
		await expect
			.poll(async () => Number(await slider.getAttribute('aria-valuenow')), {
				timeout: 10_000,
			})
			.toBeGreaterThan(0)
		expect(blockedReplayRequests).toBe(0)
		await page.getByRole('button', { exact: true, name: 'Pause' }).click()
		await page.unroute('**/api/torrents/*/files/*')
	})

	await test.step('reload resumes from IndexedDB while every file-network request is blocked', async () => {
		let blockedFileRequests = 0
		await page.route('**/api/torrents/*/files/*', async (route) => {
			blockedFileRequests += 1
			await route.abort('failed')
		})
		await page.reload()
		await authorizeDirectTorrentAccess(page)
		await expect(page.getByText(fixture.name, { exact: true })).toBeVisible()
		await expect(
			page.getByText('available offline', { exact: true })
		).toHaveCount(fixture.files.length)
		await expect
			.poll(
				async () =>
					Number(await page.getByRole('slider').getAttribute('aria-valuenow')),
				{ timeout: 20_000 }
			)
			.toBeGreaterThan(10)
		await page.getByRole('button', { exact: true, name: 'Play' }).click()
		const pauseButton = page.getByRole('button', {
			exact: true,
			name: 'Pause',
		})
		await expect(pauseButton).toBeVisible()
		await page.waitForTimeout(500)
		expect(blockedFileRequests).toBe(0)
		if (await pauseButton.isVisible()) {
			await pauseButton.click()
		}
		await page.unroute('**/api/torrents/*/files/*')
	})

	await test.step('cross-tab clear keeps offline playback uninterrupted, then Play streams and saves again', async () => {
		const finalFileRow = page.getByRole('button', {
			name: new RegExp(lastAudio?.name ?? '^$'),
		})
		await expect(finalFileRow).toHaveAttribute(
			'data-playback-source',
			'offline'
		)
		const slider = page.getByRole('slider')
		const beforePlay = Number(await slider.getAttribute('aria-valuenow'))
		await page.getByRole('button', { exact: true, name: 'Play' }).click()
		await expect(finalFileRow).toHaveAttribute(
			'data-playback-state',
			'playing-offline'
		)
		await expect
			.poll(async () => Number(await slider.getAttribute('aria-valuenow')), {
				timeout: 10_000,
			})
			.toBeGreaterThan(beforePlay)

		const metricsBeforeClear = await readJson<TransferMetrics>(
			await page.request.get('/__e2e/metrics')
		)
		const clearingPage = await context.newPage()
		await clearingPage.addInitScript(() => {
			Object.defineProperty(globalThis, 'BroadcastChannel', {
				configurable: true,
				value: undefined,
			})
		})
		await clearingPage.goto(`/playlist/${fixture.infoHash}`)
		await authorizeDirectTorrentAccess(clearingPage)
		await expect(
			clearingPage.getByText('available offline', { exact: true })
		).toHaveCount(fixture.files.length)
		await clearingPage
			.getByRole('button', { exact: true, name: 'Actions' })
			.click()
		await clearingPage
			.getByRole('button', { name: CLEAR_OFFLINE_PATTERN })
			.last()
			.click()
		await confirmAction(clearingPage, 'Clear offline data?')
		await expect(
			page.getByText('available offline', { exact: true })
		).toHaveCount(0)
		await expect(page.locator('[data-offline-bytes]')).toHaveAttribute(
			'data-offline-bytes',
			'0'
		)
		await expect(finalFileRow).toHaveAttribute(
			'data-playback-source',
			'offline'
		)
		const afterClear = Number(await slider.getAttribute('aria-valuenow'))
		await expect
			.poll(async () => Number(await slider.getAttribute('aria-valuenow')), {
				timeout: 10_000,
			})
			.toBeGreaterThan(afterClear)

		const bounds = await slider.boundingBox()
		expect(bounds).not.toBeNull()
		if (!bounds) {
			throw new Error('The playback slider has no visible bounds')
		}
		await slider.click({
			position: { x: bounds.width * 0.999, y: bounds.height / 2 },
		})
		await expect(finalFileRow).toHaveAttribute(
			'data-playback-source',
			'server',
			{ timeout: 10_000 }
		)
		const metricsAfterEnd = await readJson<TransferMetrics>(
			await page.request.get('/__e2e/metrics')
		)
		expect(
			metricsAfterEnd.fileRequests
				.slice(metricsBeforeClear.fileRequests.length)
				.some(
					(request) =>
						request.purpose === null &&
						request.contentRange?.endsWith(`/${lastAudio?.bytes ?? 0}`)
				)
		).toBe(true)

		await page.getByRole('button', { exact: true, name: 'Play' }).click()
		await expect(finalFileRow).toHaveAttribute(
			'data-playback-state',
			'streaming-saving'
		)
		await expect(finalFileRow).toContainText('streaming · saving offline')
		await page.getByRole('button', { exact: true, name: 'Pause' }).click()

		const firstFileRow = page.getByRole('button', {
			name: new RegExp(firstAudio?.name ?? '^$'),
		})
		const otherFirstFileRow = clearingPage.getByRole('button', {
			name: new RegExp(firstAudio?.name ?? '^$'),
		})
		const delayedRanges = await page.request.post('/__e2e/range-delays', {
			data: { offlineCacheRangeMs: 0, playbackRangeMs: 3000 },
		})
		expect(delayedRanges.ok(), await delayedRanges.text()).toBe(true)
		await firstFileRow.click()
		await expect
			.poll(
				async () =>
					await getCachedFileSha256(
						page,
						fixture.infoHash,
						firstAudio?.path ?? ''
					),
				{ timeout: 10_000 }
			)
			.toBe(firstAudio?.sha256)
		await expect(firstFileRow).toHaveAttribute('aria-busy', 'true')
		await expect(firstFileRow).toHaveAttribute('data-playback-source', 'server')
		await expect(firstFileRow).toHaveAttribute(
			'data-playback-source',
			'offline',
			{ timeout: 10_000 }
		)
		const restoredRanges = await page.request.post('/__e2e/range-delays', {
			data: { offlineCacheRangeMs: 200, playbackRangeMs: 0 },
		})
		expect(restoredRanges.ok(), await restoredRanges.text()).toBe(true)
		await firstFileRow.locator('..').getByTitle('Delete').click()
		await expect(firstFileRow).not.toContainText('available offline')
		await expect(otherFirstFileRow).not.toContainText('available offline')

		const metricsBeforeConcurrentSave = await readJson<TransferMetrics>(
			await page.request.get('/__e2e/metrics')
		)
		await Promise.all([firstFileRow.click(), otherFirstFileRow.click()])
		await expect(firstFileRow).toContainText('available offline', {
			timeout: 30_000,
		})
		await expect(otherFirstFileRow).toContainText('available offline', {
			timeout: 30_000,
		})
		const metricsAfterConcurrentSave = await readJson<TransferMetrics>(
			await page.request.get('/__e2e/metrics')
		)
		const concurrentRanges = metricsAfterConcurrentSave.fileRequests
			.slice(metricsBeforeConcurrentSave.fileRequests.length)
			.filter(
				(request) =>
					request.purpose === OFFLINE_CACHE_PURPOSE &&
					request.contentRange?.endsWith(`/${firstAudio?.bytes ?? 0}`)
			)
		const expectedRangeCount = Math.ceil(
			(firstAudio?.bytes ?? 0) / CACHE_CHUNK_BYTES
		)
		expect(concurrentRanges).toHaveLength(expectedRangeCount)
		expect(new Set(concurrentRanges.map(({ range }) => range)).size).toBe(
			expectedRangeCount
		)
		await clearingPage.close()

		await openAction(page, 'Download All')
		await confirmAction(page, 'Download all files?', AUTHORIZED_UPLOAD_PATTERN)
		await expect(
			page.getByText('available offline', { exact: true })
		).toHaveCount(fixture.files.length, { timeout: 30_000 })
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
		await authorizeDirectTorrentAccess(page)
		const metricsBeforeClean = await readJson<TransferMetrics>(
			await page.request.get('/__e2e/metrics')
		)
		await page.getByRole('button', { exact: true, name: 'Actions' }).click()
		await page
			.getByRole('button', { name: CLEAR_OFFLINE_PATTERN })
			.last()
			.click()
		await confirmAction(page, 'Clear offline data?')
		await expect
			.poll(async () => await getCachedFileCount(page, fixture.infoHash), {
				timeout: 10_000,
			})
			.toBe(0)
		await expect(
			page.getByText('available offline', { exact: true })
		).toHaveCount(0)
		await expect(page.locator('[data-offline-bytes]')).toHaveAttribute(
			'data-offline-bytes',
			'0'
		)
		await page.waitForTimeout(750)
		expect(await getCachedFileBytes(page, fixture.infoHash)).toBe(0)
		const metricsAfterClean = await readJson<TransferMetrics>(
			await page.request.get('/__e2e/metrics')
		)
		expect(
			metricsAfterClean.fileRequests
				.slice(metricsBeforeClean.fileRequests.length)
				.filter((request) => request.purpose === OFFLINE_CACHE_PURPOSE)
		).toEqual([])
		const summariesAfterClean = await readJson<TorrentSummary[]>(
			await page.request.get('/api/torrents')
		)
		const summaryAfterClean = summariesAfterClean.find(
			(torrent) => torrent.infoHash === fixture.infoHash
		)
		expect(summaryAfterClean?.cachedBytes).toBeGreaterThan(0)
		await expect(page.locator('[data-server-cache-bytes]')).toHaveAttribute(
			'data-server-cache-bytes',
			String(summaryAfterClean?.cachedBytes)
		)

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

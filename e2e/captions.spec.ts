import {
	type APIRequestContext,
	type APIResponse,
	expect,
	type Locator,
	type Page,
	test,
} from '@playwright/test'

const AUDIO_FILE_PATH_PATTERN = /\.(?:m4a|m4b|mp3|ogg|opus|wav)$/i
const AUTHORIZATION_CHECKBOX_PATTERN =
	/I understand that I must be legally authorized/
const DIRECT_FILE_ROUTE_PATTERN = /\/api\/torrents\/[^/]+\/files\/[^/]+$/
const AUTOMATIC_TRANSCRIPTION_LABEL = 'Automatically transcribe audiobooks'
const LIVE_CAPTIONS_LABEL = 'Live captions'
const TCAP_CONTENT_TYPE_PATTERN =
	/^application\/vnd\.tplayer\.captions; version=1$/
const TRANSCRIPTION_ELAPSED_PATTERN = /0:20/
const TRANSCRIPTION_PROGRESS_DETAIL_PATTERN = /0:20 (?:of|transcribed)/
const TERMINAL_TRANSCRIPTION_STATES = new Set([
	'cancelled',
	'completed',
	'failed',
])

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

interface TorrentFileDetails {
	id: string
	length: number
	mimeType: string
	name: string
	path: string[]
}

interface TorrentDetails {
	files: TorrentFileDetails[]
	infoHash: string
	name: string
}

interface PreloadStatus {
	downloadedBytes: number
	state: 'completed' | 'failed' | 'running'
	totalBytes: number
}

interface CaptionMetadata {
	byteLength: number
	cueCount: number
	etag: string
	formatVersion: number
	url: string
}

interface TranscriptionStatus {
	attempt: number
	captions?: CaptionMetadata
	cleanupPending?: boolean
	error?: {
		ambiguous: boolean
		code: string
		message: string
		retryable: boolean
	}
	fileId: string
	path: string[]
	processedMilliseconds: number
	queueBlockedByCleanup?: boolean
	queuedAhead?: number
	queuePosition?: number
	state:
		| 'cancelled'
		| 'completed'
		| 'failed'
		| 'preparing'
		| 'queued'
		| 'transcribing'
	totalMilliseconds?: number
	trigger: 'automatic' | 'manual'
	watchdogDeadlineAt?: string
	watchdogRemainingMilliseconds?: number
}

type TranscriptionBehavior = 'cleanup-hold' | 'failure' | 'hold' | 'success'
type TranscoderBehavior = 'cleanup-hold' | 'hold' | 'success'

interface TranscriptionCallMetric {
	behavior: TranscriptionBehavior
	inputBytes: number
	outcome: 'aborted' | 'cleanup_pending' | 'completed' | 'failed' | 'running'
	sequence: number
}

interface TranscriptionMetrics {
	calls: TranscriptionCallMetric[]
	cleanupReleasePending: boolean
	inFlight: number
	manager: {
		activeJobs: number
		automaticTranscription: boolean
		healthy: boolean
		queuedJobs: number
		stalledJobs: number
	}
	queuedBehaviors: TranscriptionBehavior[]
	transcoder: {
		calls: Array<{
			behavior: TranscoderBehavior
			outcome:
				| 'aborted'
				| 'cleanup_pending'
				| 'completed'
				| 'failed'
				| 'running'
			sequence: number
		}>
		inFlight: number
		queuedBehaviors: TranscoderBehavior[]
	}
}

interface StoredCaptionSummary {
	byteLength: number
	cueCount: number
	etag: string
	fileLength: number
	formatVersion: number
	language: string | null
}

const readJson = async <Value>(response: APIResponse): Promise<Value> => {
	expect(response.ok(), await response.text()).toBe(true)
	return (await response.json()) as Value
}

const escapePattern = (value: string): string =>
	value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const fileButton = (page: Page, file: TorrentFileDetails) =>
	page.getByRole('button', { name: new RegExp(escapePattern(file.name)) })

const firstGlyphAnchor = async (
	captionSlot: Locator
): Promise<{ x: number; y: number }> =>
	await captionSlot.evaluate((element) => {
		const textNode = [...element.childNodes].find(
			(node) => node.nodeType === Node.TEXT_NODE && node.textContent
		)
		if (!textNode) {
			throw new Error('Caption slot has no text node')
		}
		const range = document.createRange()
		range.setStart(textNode, 0)
		range.setEnd(textNode, 1)
		const { x, y } = range.getBoundingClientRect()
		return { x, y }
	})

const configureTranscription = async (
	request: APIRequestContext,
	behaviors: readonly TranscriptionBehavior[],
	resetMetrics = false,
	nextWindowSplitMilliseconds?: number,
	transcoderBehaviors: readonly TranscoderBehavior[] = []
): Promise<void> => {
	const response = await request.post('/__e2e/transcription-control', {
		data: {
			behaviors,
			...(nextWindowSplitMilliseconds === undefined
				? {}
				: { nextWindowSplitMilliseconds }),
			resetMetrics,
			transcoderBehaviors,
		},
	})
	expect(response.ok(), await response.text()).toBe(true)
}

const transcriptionMetrics = async (
	request: APIRequestContext
): Promise<TranscriptionMetrics> =>
	await readJson<TranscriptionMetrics>(
		await request.get('/__e2e/transcription-metrics')
	)

const releaseTranscriptionCleanup = async (
	request: APIRequestContext
): Promise<boolean> => {
	const response = await request.post('/__e2e/transcription-release-cleanup')
	return (
		await readJson<{
			released: boolean
		}>(response)
	).released
}

const listTranscriptions = async (
	request: APIRequestContext,
	infoHash: string
): Promise<TranscriptionStatus[]> =>
	await readJson<TranscriptionStatus[]>(
		await request.get(`/api/torrents/${infoHash}/transcriptions`)
	)

const waitForPreload = async (
	request: APIRequestContext,
	fixture: FixtureDescriptor
): Promise<void> => {
	const started = await request.post(
		`/api/torrents/${fixture.infoHash}/preload`
	)
	expect(started.status(), await started.text()).toBe(202)
	await expect
		.poll(
			async () => {
				const response = await request.get(
					`/api/torrents/${fixture.infoHash}/preload`
				)
				if (!response.ok()) {
					return 'missing'
				}
				return ((await response.json()) as PreloadStatus).state
			},
			{ timeout: 30_000 }
		)
		.toBe('completed')
	const status = await readJson<PreloadStatus>(
		await request.get(`/api/torrents/${fixture.infoHash}/preload`)
	)
	expect(status.downloadedBytes).toBe(fixture.totalBytes)
	expect(status.totalBytes).toBe(fixture.totalBytes)
}

const authorizeTorrent = async (page: Page): Promise<void> => {
	const dialog = page.getByRole('dialog')
	await expect(dialog).toContainText('Before opening peer-to-peer content')
	await dialog
		.getByRole('checkbox', {
			name: AUTHORIZATION_CHECKBOX_PATTERN,
		})
		.check()
	await dialog
		.getByRole('button', {
			exact: true,
			name: 'I understand — continue',
		})
		.click()
	await expect(dialog).toHaveCount(0)
}

const getStoredCaption = async (
	page: Page,
	infoHash: string,
	path: string
): Promise<StoredCaptionSummary | null> =>
	await page.evaluate(
		async ({ databaseName, hash, requestedPath }) => {
			const database = await new Promise<IDBDatabase>((resolve, reject) => {
				const request = indexedDB.open(databaseName)
				request.onerror = () => reject(request.error)
				request.onsuccess = () => resolve(request.result)
			})
			try {
				return await new Promise<StoredCaptionSummary | null>(
					(resolve, reject) => {
						const transaction = database.transaction('captions', 'readonly')
						const request = transaction
							.objectStore('captions')
							.get([hash, requestedPath])
						request.onerror = () => reject(request.error)
						request.onsuccess = () => {
							const record = request.result as
								| {
										bytes?: ArrayBuffer
										cueCount?: number
										etag?: string
										fileLength?: number
										formatVersion?: number
										language?: string
								  }
								| undefined
							if (!record?.bytes) {
								resolve(null)
								return
							}
							resolve({
								byteLength: record.bytes.byteLength,
								cueCount: record.cueCount ?? 0,
								etag: record.etag ?? '',
								fileLength: record.fileLength ?? 0,
								formatVersion: record.formatVersion ?? 0,
								language: record.language ?? null,
							})
						}
					}
				)
			} finally {
				database.close()
			}
		},
		{ databaseName: 'books', hash: infoHash, requestedPath: path }
	)

const cleanupFixture = async (
	request: APIRequestContext,
	infoHash: string
): Promise<void> => {
	await request.put('/api/settings/transcription', {
		data: { automaticTranscription: false },
	})
	await request.delete(`/api/torrents/${infoHash}/transcriptions`)
	await request.delete(`/api/torrents/${infoHash}`)
}

test('automatic local transcription powers persistent live captions and explicit recovery controls', async ({
	page,
	request,
}) => {
	const fixture = await readJson<FixtureDescriptor>(
		await request.get('/__e2e/fixture')
	)
	try {
		await test.step('automatic transcription is off and local completion stays idle', async () => {
			const settings = await readJson<{ automaticTranscription: boolean }>(
				await request.get('/api/settings/transcription')
			)
			expect(settings.automaticTranscription).toBe(false)

			const registration = await request.post('/api/torrents', {
				data: { torrentId: fixture.magnetUri },
			})
			expect(registration.status(), await registration.text()).toBe(202)
			await waitForPreload(request, fixture)
			expect((await transcriptionMetrics(request)).calls).toEqual([])
		})

		const details = await readJson<TorrentDetails>(
			await request.get(`/api/torrents/${fixture.infoHash}`)
		)
		const audioFiles = details.files.filter((file) =>
			AUDIO_FILE_PATH_PATTERN.test(file.path.join('/'))
		)
		expect(audioFiles).toHaveLength(2)

		await test.step('enabling the setting schedules every locally available audio file', async () => {
			await configureTranscription(request, ['success', 'failure'], true)
			await page.goto('/settings')
			const automatic = page.getByRole('checkbox', {
				exact: true,
				name: AUTOMATIC_TRANSCRIPTION_LABEL,
			})
			await expect(automatic).not.toBeChecked()
			await automatic.click()
			await expect(automatic).toBeChecked()

			await expect
				.poll(
					async () => {
						const statuses = await listTranscriptions(request, fixture.infoHash)
						return statuses
							.filter((status) =>
								TERMINAL_TRANSCRIPTION_STATES.has(status.state)
							)
							.map((status) => status.state)
							.sort()
					},
					{ timeout: 30_000 }
				)
				.toEqual(['completed', 'failed'])

			const metrics = await transcriptionMetrics(request)
			expect(metrics.manager.automaticTranscription).toBe(true)
			expect(metrics.calls).toHaveLength(2)
			expect(metrics.calls.map(({ behavior }) => behavior)).toEqual([
				'success',
				'failure',
			])
			expect(metrics.calls.map(({ outcome }) => outcome)).toEqual([
				'completed',
				'failed',
			])
			expect(metrics.calls.every(({ inputBytes }) => inputBytes > 0)).toBe(true)
		})

		const statuses = await listTranscriptions(request, fixture.infoHash)
		const completed = statuses.find((status) => status.state === 'completed')
		const failed = statuses.find((status) => status.state === 'failed')
		expect(completed?.trigger).toBe('automatic')
		expect(failed?.trigger).toBe('automatic')
		expect(failed?.error).toMatchObject({
			code: 'e2e_provider_failure',
			retryable: true,
		})
		if (!(completed?.captions && failed)) {
			throw new Error('Expected one completed and one failed transcription')
		}
		const completedFile = audioFiles.find(
			(file) => file.id === completed.fileId
		)
		const failedFile = audioFiles.find((file) => file.id === failed.fileId)
		if (!(completedFile && failedFile)) {
			throw new Error('Transcription jobs did not map to audio fixture files')
		}

		await test.step('the server persists a compact TCAP artifact', async () => {
			const response = await request.get(completed.captions?.url ?? '')
			expect(response.ok(), await response.text()).toBe(true)
			expect(response.headers()['content-type']).toMatch(
				TCAP_CONTENT_TYPE_PATTERN
			)
			expect(response.headers().etag).toBe(completed.captions?.etag)
			const bytes = await response.body()
			expect(bytes.subarray(0, 4).toString('ascii')).toBe('TCAP')
			expect(bytes.byteLength).toBe(completed.captions?.byteLength)
			expect(bytes.byteLength).toBeLessThan(2048)
		})

		await test.step('the independent Live captions toggle follows play, pause, rate, and seek', async () => {
			const originalViewport = page.viewportSize() ?? {
				height: 720,
				width: 1280,
			}
			await page.setViewportSize({ height: 895, width: 509 })
			await page.goto(`/playlist/${fixture.infoHash}`)
			await authorizeTorrent(page)
			await expect(page.getByText(fixture.name, { exact: true })).toBeVisible()
			const selectedFile = fileButton(page, completedFile)
			await selectedFile.click()
			const liveToggle = page.getByRole('button', {
				exact: true,
				name: LIVE_CAPTIONS_LABEL,
			})
			await expect(liveToggle).toHaveAttribute('aria-pressed', 'false')
			await expect(
				page.getByRole('region', { name: LIVE_CAPTIONS_LABEL })
			).toHaveCount(0)
			await liveToggle.click()
			await expect(liveToggle).toHaveAttribute('aria-pressed', 'true')

			const captions = page.getByRole('region', {
				exact: true,
				name: LIVE_CAPTIONS_LABEL,
			})
			await expect(captions).toHaveAttribute('data-caption-state', 'ready', {
				timeout: 20_000,
			})
			await expect(
				captions.getByText('Private swarm captions stay local.', {
					exact: true,
				})
			).toBeVisible()
			const captionSlots = captions.locator('[data-caption-slot]')
			const currentCaption = captions.locator('[data-caption-slot="current"]')
			await expect(captionSlots).toHaveCount(3)
			await expect(currentCaption).toHaveText(
				'Private swarm captions stay local.'
			)
			const captionBounds = await captions.boundingBox()
			const slider = page.getByRole('slider', { name: 'Playback position' })
			const sliderBounds = await slider.boundingBox()
			if (!(captionBounds && sliderBounds)) {
				throw new Error(
					'Caption stage or playback slider has no visible bounds'
				)
			}
			expect(captionBounds.height).toBeGreaterThanOrEqual(200)
			expect(captionBounds.y + captionBounds.height).toBeLessThanOrEqual(
				sliderBounds.y + 1
			)
			const captionOverflow = await captions
				.locator('[data-caption-layout="fixed-three-row"]')
				.evaluate((element) => ({
					clientWidth: element.clientWidth,
					scrollWidth: element.scrollWidth,
				}))
			expect(captionOverflow.scrollWidth).toBeLessThanOrEqual(
				captionOverflow.clientWidth
			)

			const path = completedFile.path.join('/')
			await expect
				.poll(
					async () => await getStoredCaption(page, fixture.infoHash, path),
					{ timeout: 10_000 }
				)
				.toMatchObject({
					byteLength: completed.captions?.byteLength,
					cueCount: completed.captions?.cueCount,
					etag: completed.captions?.etag,
					fileLength: completedFile.length,
					formatVersion: 1,
					language: 'en',
				})

			const rate = page.getByRole('button', { exact: true, name: 'x1' })
			await rate.click()
			await expect(
				page.getByRole('button', { exact: true, name: 'x1.25' })
			).toBeVisible()
			await page.getByRole('button', { exact: true, name: 'Play' }).click()
			await expect(
				page.getByRole('button', { exact: true, name: 'Pause' })
			).toBeVisible()
			await expect(currentCaption).toHaveText('Playback remains responsive.', {
				timeout: 10_000,
			})
			const playbackAnchor = await firstGlyphAnchor(currentCaption)
			const captionTypography = await captionSlots.evaluateAll((elements) =>
				elements.map((element) => {
					const style = getComputedStyle(element)
					return {
						fontFamily: style.fontFamily,
						fontSize: style.fontSize,
						fontWeight: style.fontWeight,
						letterSpacing: style.letterSpacing,
						lineHeight: style.lineHeight,
						textAlign: style.textAlign,
					}
				})
			)
			expect(captionTypography).toHaveLength(3)
			expect(captionTypography[0]?.textAlign).toBe('left')
			expect(captionTypography[1]).toEqual(captionTypography[0])
			expect(captionTypography[2]).toEqual(captionTypography[0])
			await page.getByRole('button', { exact: true, name: 'Pause' }).click()

			const bounds = await slider.boundingBox()
			if (!bounds) {
				throw new Error('Playback slider has no visible bounds')
			}
			await page.mouse.click(
				bounds.x + bounds.width / 2,
				bounds.y + bounds.height / 2
			)
			await expect(currentCaption).toHaveText(
				'Seeking keeps captions aligned.',
				{
					timeout: 5000,
				}
			)
			const seekAnchor = await firstGlyphAnchor(currentCaption)
			expect(seekAnchor.x).toBeCloseTo(playbackAnchor.x, 1)
			expect(seekAnchor.y).toBeCloseTo(playbackAnchor.y, 1)
			await expect(selectedFile).toContainText('available offline', {
				timeout: 30_000,
			})
			await page.setViewportSize(originalViewport)
		})

		await test.step('IndexedDB captions survive server-route failure, reload, and offline playback', async () => {
			let blockedAudioRequests = 0
			let blockedServerRequests = 0
			await page.route('**/api/**', async (route) => {
				blockedServerRequests += 1
				if (
					DIRECT_FILE_ROUTE_PATTERN.test(
						new URL(route.request().url()).pathname
					)
				) {
					blockedAudioRequests += 1
				}
				await route.abort('failed')
			})
			const liveToggle = page.getByRole('button', {
				exact: true,
				name: LIVE_CAPTIONS_LABEL,
			})
			await liveToggle.click()
			await expect(liveToggle).toHaveAttribute('aria-pressed', 'false')
			await expect(
				page.getByRole('region', {
					exact: true,
					name: LIVE_CAPTIONS_LABEL,
				})
			).toHaveCount(0)
			await liveToggle.click()
			const captions = page.getByRole('region', {
				exact: true,
				name: LIVE_CAPTIONS_LABEL,
			})
			await expect(captions).toHaveAttribute('data-caption-state', 'ready')
			await expect(captions).toContainText(
				'Saved captions are available. The transcription service could not be reached.'
			)
			await expect.poll(() => blockedServerRequests).toBeGreaterThan(0)

			blockedAudioRequests = 0
			blockedServerRequests = 0
			await page.reload()
			await expect(captions).toHaveAttribute('data-caption-state', 'ready', {
				timeout: 20_000,
			})
			await expect(liveToggle).toHaveAttribute('aria-pressed', 'true')
			await expect(captions).toContainText(
				'Saved captions are available. The transcription service could not be reached.'
			)
			const selectedFile = fileButton(page, completedFile)
			await expect(selectedFile).toHaveAttribute(
				'data-playback-source',
				'offline'
			)
			const slider = page.getByRole('slider', { name: 'Playback position' })
			const beforePlay = Number(await slider.getAttribute('aria-valuenow'))
			const blockedAudioBeforeOfflinePlay = blockedAudioRequests
			await page.getByRole('button', { exact: true, name: 'Play' }).click()
			await expect(selectedFile).toHaveAttribute(
				'data-playback-state',
				'playing-offline'
			)
			await expect
				.poll(async () => Number(await slider.getAttribute('aria-valuenow')), {
					timeout: 10_000,
				})
				.toBeGreaterThan(beforePlay)
			expect(blockedAudioRequests).toBe(blockedAudioBeforeOfflinePlay)
			expect(blockedServerRequests).toBeGreaterThan(0)
			await page.getByRole('button', { exact: true, name: 'Pause' }).click()
			await page.unroute('**/api/**')
		})

		await test.step('a retry can be cancelled and then completes cleanly', async () => {
			const failedFileRow = fileButton(page, failedFile)
			await failedFileRow.click()
			const captions = page.getByRole('region', {
				exact: true,
				name: LIVE_CAPTIONS_LABEL,
			})
			await expect(captions).toHaveAttribute('data-caption-state', 'failed', {
				timeout: 10_000,
			})
			await expect(captions).toContainText(
				'Deterministic transcription failure.'
			)

			await configureTranscription(request, ['success', 'hold'], false, 20_000)
			await captions
				.getByRole('button', { exact: true, name: 'Retry transcription' })
				.click()
			await expect
				.poll(async () => {
					const status = (
						await listTranscriptions(request, fixture.infoHash)
					).find(({ fileId }) => fileId === failedFile.id)
					return status
						? {
								processedMilliseconds: status.processedMilliseconds,
								state: status.state,
								totalMilliseconds: status.totalMilliseconds ?? null,
							}
						: null
				})
				.toEqual({
					processedMilliseconds: 20_000,
					state: 'transcribing',
					totalMilliseconds: null,
				})
			await expect
				.poll(async () => (await transcriptionMetrics(request)).inFlight)
				.toBe(1)
			await expect(captions).toHaveAttribute(
				'data-caption-state',
				'transcribing'
			)
			const transcriptionProgress = captions.getByRole('progressbar', {
				name: 'Transcription progress',
			})
			await expect(transcriptionProgress).toBeVisible()
			await expect(transcriptionProgress).toHaveAttribute(
				'aria-valuetext',
				TRANSCRIPTION_ELAPSED_PATTERN
			)
			await expect(
				captions.getByText(TRANSCRIPTION_PROGRESS_DETAIL_PATTERN)
			).toBeVisible()
			await captions
				.getByRole('button', {
					exact: true,
					name: 'Cancel transcription',
				})
				.click()
			await expect(captions).toHaveAttribute('data-caption-state', 'cancelled')
			await expect
				.poll(async () => (await transcriptionMetrics(request)).inFlight)
				.toBe(0)

			await configureTranscription(request, ['success'])
			await captions
				.getByRole('button', { exact: true, name: 'Restart transcription' })
				.click()
			await expect(captions).toHaveAttribute('data-caption-state', 'ready', {
				timeout: 20_000,
			})
			await expect(
				captions.getByText('Private swarm captions stay local.', {
					exact: true,
				})
			).toBeVisible()

			const metrics = await transcriptionMetrics(request)
			expect(metrics.calls.map(({ outcome }) => outcome)).toEqual([
				'completed',
				'failed',
				'completed',
				'aborted',
				'completed',
			])
		})
	} finally {
		await cleanupFixture(request, fixture.infoHash)
	}
})

test('a stalled local transcoder is contained, advances the queue, and releases every in-flight resource', async ({
	page,
	request,
}) => {
	const fixture = await readJson<FixtureDescriptor>(
		await request.get('/__e2e/fixture')
	)
	try {
		const registration = await request.post('/api/torrents', {
			data: { torrentId: fixture.magnetUri },
		})
		expect(registration.status(), await registration.text()).toBe(202)
		await waitForPreload(request, fixture)

		const details = await readJson<TorrentDetails>(
			await request.get(`/api/torrents/${fixture.infoHash}`)
		)
		const audioFiles = details.files.filter((file) =>
			AUDIO_FILE_PATH_PATTERN.test(file.path.join('/'))
		)
		expect(audioFiles).toHaveLength(2)

		await test.step('the queue reports the active watchdog and the exact place of the waiting chapter', async () => {
			await configureTranscription(request, ['success'], true, undefined, [
				'hold',
				'success',
			])
			const setting = await request.put('/api/settings/transcription', {
				data: { automaticTranscription: true },
			})
			expect(setting.ok(), await setting.text()).toBe(true)

			await expect
				.poll(async () => {
					const statuses = await listTranscriptions(request, fixture.infoHash)
					return {
						active: statuses.filter(
							({ state }) => state === 'preparing' || state === 'transcribing'
						).length,
						queued: statuses.filter(({ state }) => state === 'queued').length,
					}
				})
				.toEqual({ active: 1, queued: 1 })

			const statuses = await listTranscriptions(request, fixture.infoHash)
			const active = statuses.find(
				({ state }) => state === 'preparing' || state === 'transcribing'
			)
			const queued = statuses.find(({ state }) => state === 'queued')
			expect(active).toMatchObject({
				queuedAhead: 0,
				queuePosition: 1,
				trigger: 'automatic',
			})
			expect(queued).toMatchObject({
				queuedAhead: 1,
				queuePosition: 2,
				trigger: 'automatic',
			})
			expect(active?.watchdogDeadlineAt).toBeDefined()
			expect(Date.parse(active?.watchdogDeadlineAt ?? '')).toBeGreaterThan(
				Date.now()
			)

			if (!queued) {
				throw new Error('Expected one queued transcription')
			}
			const queuedFile = audioFiles.find(({ id }) => id === queued.fileId)
			if (!queuedFile) {
				throw new Error('Queued transcription did not map to an audio file')
			}

			await page.goto(`/playlist/${fixture.infoHash}`)
			await authorizeTorrent(page)
			await fileButton(page, queuedFile).click()
			const liveToggle = page.getByRole('button', {
				exact: true,
				name: LIVE_CAPTIONS_LABEL,
			})
			await liveToggle.click()
			const captions = page.getByRole('region', {
				exact: true,
				name: LIVE_CAPTIONS_LABEL,
			})
			await expect(captions).toHaveAttribute('data-caption-state', 'queued')
			await expect(captions).toContainText('Queue position 2')
			await expect(captions).toContainText('Attempt 1')
		})

		let failedFile: TorrentFileDetails | undefined
		await test.step('the watchdog fails only the stalled job and the next chapter completes', async () => {
			await expect
				.poll(
					async () => {
						const statuses = await listTranscriptions(request, fixture.infoHash)
						const metrics = await transcriptionMetrics(request)
						return {
							activeJobs: metrics.manager.activeJobs,
							providerInFlight: metrics.inFlight,
							states: statuses.map(({ state }) => state).sort(),
							transcoderInFlight: metrics.transcoder.inFlight,
						}
					},
					{ timeout: 30_000 }
				)
				.toEqual({
					activeJobs: 0,
					providerInFlight: 0,
					states: ['completed', 'failed'],
					transcoderInFlight: 0,
				})

			const statuses = await listTranscriptions(request, fixture.infoHash)
			const failed = statuses.find(({ state }) => state === 'failed')
			const completed = statuses.find(({ state }) => state === 'completed')
			expect(failed?.error).toMatchObject({
				ambiguous: false,
				code: 'transcription_stalled',
				retryable: true,
			})
			expect(completed?.captions).toBeDefined()
			expect(failed).not.toHaveProperty('watchdogDeadlineAt')
			expect(completed).not.toHaveProperty('watchdogDeadlineAt')
			failedFile = audioFiles.find(({ id }) => id === failed?.fileId)
			expect(failedFile).toBeDefined()

			const metrics = await transcriptionMetrics(request)
			expect(metrics.manager).toMatchObject({
				activeJobs: 0,
				healthy: true,
				queuedJobs: 0,
				stalledJobs: 0,
			})
			expect(metrics.inFlight).toBe(0)
			expect(metrics.queuedBehaviors).toEqual([])
			expect(metrics.transcoder.inFlight).toBe(0)
			expect(metrics.transcoder.queuedBehaviors).toEqual([])
			expect(metrics.transcoder.calls.map(({ behavior }) => behavior)).toEqual([
				'hold',
				'success',
			])
			expect(metrics.transcoder.calls.map(({ outcome }) => outcome)).toEqual([
				'aborted',
				'completed',
			])
			expect(metrics.calls.map(({ outcome }) => outcome)).toEqual(['completed'])
		})

		await test.step('cancellation is confirmed, retry recovers, and no work remains in flight', async () => {
			if (!failedFile) {
				throw new Error('Expected the watchdog-failed audio file')
			}
			await fileButton(page, failedFile).click()
			const captions = page.getByRole('region', {
				exact: true,
				name: LIVE_CAPTIONS_LABEL,
			})
			await expect(captions).toHaveAttribute('data-caption-state', 'failed')
			await expect(captions).toContainText(
				'Transcription stopped making progress and was ended by the server.'
			)

			await configureTranscription(request, ['success', 'hold'], false, 20_000)
			await captions
				.getByRole('button', { exact: true, name: 'Retry transcription' })
				.click()
			await expect
				.poll(async () => {
					const status = (
						await listTranscriptions(request, fixture.infoHash)
					).find(({ fileId }) => fileId === failedFile?.id)
					return status
						? {
								processedMilliseconds: status.processedMilliseconds,
								state: status.state,
							}
						: null
				})
				.toEqual({ processedMilliseconds: 20_000, state: 'transcribing' })
			await expect(captions).toHaveAttribute(
				'data-caption-state',
				'transcribing'
			)
			let releaseCancellationResponse = (): void => undefined
			const cancellationResponseGate = new Promise<void>((resolve) => {
				releaseCancellationResponse = resolve
			})
			const cancellationRoute = `**/api/torrents/${fixture.infoHash}/files/${failedFile.id}/transcription`
			await page.route(cancellationRoute, async (route) => {
				if (route.request().method() !== 'DELETE') {
					await route.fallback()
					return
				}
				const response = await route.fetch()
				await cancellationResponseGate
				await route.fulfill({ response })
			})
			await captions
				.getByRole('button', {
					exact: true,
					name: 'Cancel transcription',
				})
				.click()
			await expect(captions).toHaveAttribute('data-caption-state', 'cancelling')
			await expect(captions).toContainText('Cancelling transcription…')
			releaseCancellationResponse()
			await expect(captions).toHaveAttribute('data-caption-state', 'cancelled')
			await page.unroute(cancellationRoute)
			await expect(captions).toContainText('Transcription was cancelled.')
			await expect(
				captions.getByRole('button', {
					exact: true,
					name: 'Restart transcription',
				})
			).toBeVisible()

			await expect
				.poll(async () => {
					const metrics = await transcriptionMetrics(request)
					return {
						activeJobs: metrics.manager.activeJobs,
						providerInFlight: metrics.inFlight,
						queuedJobs: metrics.manager.queuedJobs,
						stalledJobs: metrics.manager.stalledJobs,
						transcoderInFlight: metrics.transcoder.inFlight,
					}
				})
				.toEqual({
					activeJobs: 0,
					providerInFlight: 0,
					queuedJobs: 0,
					stalledJobs: 0,
					transcoderInFlight: 0,
				})

			await configureTranscription(request, ['success'])
			await captions
				.getByRole('button', {
					exact: true,
					name: 'Restart transcription',
				})
				.click()
			await expect(captions).toHaveAttribute('data-caption-state', 'ready', {
				timeout: 20_000,
			})
			await expect(
				captions.getByText('Private swarm captions stay local.', {
					exact: true,
				})
			).toBeVisible()

			const metrics = await transcriptionMetrics(request)
			expect(metrics.manager).toMatchObject({
				activeJobs: 0,
				healthy: true,
				queuedJobs: 0,
				stalledJobs: 0,
			})
			expect(metrics.inFlight).toBe(0)
			expect(metrics.queuedBehaviors).toEqual([])
			expect(metrics.transcoder.inFlight).toBe(0)
			expect(metrics.transcoder.queuedBehaviors).toEqual([])
		})
	} finally {
		await cleanupFixture(request, fixture.infoHash)
	}
})

test('cleanup-pending cancellation survives reload and cannot restart until every resource is released', async ({
	page,
	request,
}) => {
	const fixture = await readJson<FixtureDescriptor>(
		await request.get('/__e2e/fixture')
	)
	try {
		const registration = await request.post('/api/torrents', {
			data: { torrentId: fixture.magnetUri },
		})
		expect(registration.status(), await registration.text()).toBe(202)
		await waitForPreload(request, fixture)

		const details = await readJson<TorrentDetails>(
			await request.get(`/api/torrents/${fixture.infoHash}`)
		)
		const audioFile = details.files.find((file) =>
			AUDIO_FILE_PATH_PATTERN.test(file.path.join('/'))
		)
		if (!audioFile) {
			throw new Error('The deterministic fixture has no audio file')
		}

		await configureTranscription(request, ['cleanup-hold'], true, undefined, [
			'cleanup-hold',
		])
		const queued = await request.post(
			`/api/torrents/${fixture.infoHash}/files/${audioFile.id}/transcription`
		)
		expect(queued.status(), await queued.text()).toBe(202)
		await expect
			.poll(async () => {
				const metrics = await transcriptionMetrics(request)
				return {
					providerInFlight: metrics.inFlight,
					transcoderInFlight: metrics.transcoder.inFlight,
				}
			})
			.toEqual({ providerInFlight: 1, transcoderInFlight: 1 })

		await page.goto(`/playlist/${fixture.infoHash}`)
		await authorizeTorrent(page)
		await fileButton(page, audioFile).click()
		await page
			.getByRole('button', { exact: true, name: LIVE_CAPTIONS_LABEL })
			.click()
		const captions = page.getByRole('region', {
			exact: true,
			name: LIVE_CAPTIONS_LABEL,
		})
		await expect(captions).toHaveAttribute('data-caption-state', 'transcribing')

		await captions
			.getByRole('button', { exact: true, name: 'Cancel transcription' })
			.click()
		await expect(captions).toHaveAttribute('data-caption-cleanup', 'pending', {
			timeout: 10_000,
		})
		await expect(captions).toHaveAttribute('data-caption-state', 'cancelling')
		await expect(captions).toHaveAttribute('aria-busy', 'true')
		await expect(captions).toContainText(
			'Cancellation was accepted. TPlayer is releasing local transcription resources before this chapter can be restarted.'
		)
		await expect(captions).toContainText('Releasing local resources')
		await expect(
			captions.getByRole('button', {
				exact: true,
				name: 'Restart transcription',
			})
		).toHaveCount(0)
		await expect(
			captions.getByRole('button', {
				exact: true,
				name: 'Retry transcription',
			})
		).toHaveCount(0)

		const pendingStatus = (
			await listTranscriptions(request, fixture.infoHash)
		).find(({ fileId }) => fileId === audioFile.id)
		expect(pendingStatus).toMatchObject({
			attempt: 1,
			cleanupPending: true,
			state: 'cancelled',
		})
		let metrics = await transcriptionMetrics(request)
		expect(metrics).toMatchObject({
			cleanupReleasePending: true,
			inFlight: 1,
			manager: {
				activeJobs: 1,
				healthy: false,
				queuedJobs: 0,
				stalledJobs: 1,
			},
			transcoder: { inFlight: 1 },
		})
		expect(metrics.calls.map(({ outcome }) => outcome)).toEqual([
			'cleanup_pending',
		])
		expect(metrics.transcoder.calls.map(({ outcome }) => outcome)).toEqual([
			'cleanup_pending',
		])

		await page.reload()
		await fileButton(page, audioFile).click()
		await expect(captions).toHaveAttribute('data-caption-cleanup', 'pending', {
			timeout: 15_000,
		})
		await expect(captions).toHaveAttribute('data-caption-state', 'cancelling')
		await expect(captions).toContainText(
			'Cancellation was accepted. TPlayer is releasing local transcription resources before this chapter can be restarted.'
		)
		await expect(
			captions.getByRole('button', {
				exact: true,
				name: 'Restart transcription',
			})
		).toHaveCount(0)
		metrics = await transcriptionMetrics(request)
		expect(metrics.calls).toHaveLength(1)
		expect(metrics.transcoder.calls).toHaveLength(1)

		expect(await releaseTranscriptionCleanup(request)).toBe(true)
		await expect(captions).toHaveAttribute('data-caption-cleanup', 'settled', {
			timeout: 15_000,
		})
		await expect(captions).toHaveAttribute('data-caption-state', 'cancelled')
		await expect(captions).toContainText('Transcription was cancelled.')
		await expect(
			captions.getByRole('button', {
				exact: true,
				name: 'Restart transcription',
			})
		).toBeVisible()

		await expect
			.poll(async () => {
				const settled = await transcriptionMetrics(request)
				return {
					activeJobs: settled.manager.activeJobs,
					cleanupReleasePending: settled.cleanupReleasePending,
					healthy: settled.manager.healthy,
					providerInFlight: settled.inFlight,
					queuedJobs: settled.manager.queuedJobs,
					stalledJobs: settled.manager.stalledJobs,
					transcoderInFlight: settled.transcoder.inFlight,
				}
			})
			.toEqual({
				activeJobs: 0,
				cleanupReleasePending: false,
				healthy: true,
				providerInFlight: 0,
				queuedJobs: 0,
				stalledJobs: 0,
				transcoderInFlight: 0,
			})
		metrics = await transcriptionMetrics(request)
		expect(metrics.calls.map(({ outcome }) => outcome)).toEqual(['aborted'])
		expect(metrics.transcoder.calls.map(({ outcome }) => outcome)).toEqual([
			'aborted',
		])
	} finally {
		await releaseTranscriptionCleanup(request)
		await expect
			.poll(
				async () => (await transcriptionMetrics(request)).manager.activeJobs
			)
			.toBe(0)
		await cleanupFixture(request, fixture.infoHash)
	}
})

test('automatic transcription stays visibly off while slow cancellation releases resources', async ({
	page,
	request,
}) => {
	const fixture = await readJson<FixtureDescriptor>(
		await request.get('/__e2e/fixture')
	)
	const cleanupMessage =
		'Automatic transcription is off. TPlayer is finishing cancellation and releasing local resources.'
	try {
		const registration = await request.post('/api/torrents', {
			data: { torrentId: fixture.magnetUri },
		})
		expect(registration.status(), await registration.text()).toBe(202)
		await waitForPreload(request, fixture)
		await configureTranscription(request, ['cleanup-hold'], true, undefined, [
			'cleanup-hold',
		])

		await page.goto('/settings')
		const automatic = page.getByRole('checkbox', {
			exact: true,
			name: AUTOMATIC_TRANSCRIPTION_LABEL,
		})
		await expect(automatic).not.toBeChecked()
		await automatic.click()
		await expect(automatic).toBeChecked()
		await expect
			.poll(async () => {
				const metrics = await transcriptionMetrics(request)
				return {
					activeJobs: metrics.manager.activeJobs,
					providerInFlight: metrics.inFlight,
					queuedJobs: metrics.manager.queuedJobs,
					transcoderInFlight: metrics.transcoder.inFlight,
				}
			})
			.toEqual({
				activeJobs: 1,
				providerInFlight: 1,
				queuedJobs: 1,
				transcoderInFlight: 1,
			})

		await automatic.click()
		await expect(automatic).not.toBeChecked({ timeout: 10_000 })
		await expect(page.getByText(cleanupMessage, { exact: true })).toBeVisible()
		await expect(page.getByRole('alert')).toHaveCount(0)
		const pendingSetting = await readJson<{
			automaticTranscription: boolean
			cleanupPending: boolean
		}>(await request.get('/api/settings/transcription'))
		expect(pendingSetting).toEqual({
			automaticTranscription: false,
			cleanupPending: true,
		})

		await page.reload()
		await expect(automatic).not.toBeChecked()
		await expect(page.getByText(cleanupMessage, { exact: true })).toBeVisible()
		expect(await releaseTranscriptionCleanup(request)).toBe(true)
		await expect(page.getByText(cleanupMessage, { exact: true })).toHaveCount(
			0,
			{
				timeout: 15_000,
			}
		)
		await expect(automatic).not.toBeChecked()

		await expect
			.poll(async () => {
				const metrics = await transcriptionMetrics(request)
				return {
					activeJobs: metrics.manager.activeJobs,
					cleanupReleasePending: metrics.cleanupReleasePending,
					healthy: metrics.manager.healthy,
					providerInFlight: metrics.inFlight,
					queuedJobs: metrics.manager.queuedJobs,
					transcoderInFlight: metrics.transcoder.inFlight,
				}
			})
			.toEqual({
				activeJobs: 0,
				cleanupReleasePending: false,
				healthy: true,
				providerInFlight: 0,
				queuedJobs: 0,
				transcoderInFlight: 0,
			})
		const metrics = await transcriptionMetrics(request)
		expect(metrics.calls.map(({ outcome }) => outcome)).toEqual(['aborted'])
		expect(metrics.transcoder.calls.map(({ outcome }) => outcome)).toEqual([
			'aborted',
		])
	} finally {
		await releaseTranscriptionCleanup(request)
		await expect
			.poll(
				async () => (await transcriptionMetrics(request)).manager.activeJobs
			)
			.toBe(0)
		await cleanupFixture(request, fixture.infoHash)
	}
})

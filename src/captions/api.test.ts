import { describe, expect, test } from 'bun:test'
import { CaptionApiClient, CaptionApiError } from './api'

const INFO_HASH = '0123456789abcdef0123456789abcdef01234567'

const completedStatus = {
	attempt: 1,
	captions: {
		byteLength: 4,
		cueCount: 1,
		durationMilliseconds: 2000,
		etag: '"tcap-one"',
		formatVersion: 1,
		language: 'en',
		updatedAt: '2026-09-04T10:00:01.000Z',
		url: `/api/torrents/${INFO_HASH}/files/7/captions`,
	},
	createdAt: '2026-09-04T10:00:00.000Z',
	fileId: 7,
	fileLength: 42,
	finishedAt: '2026-09-04T10:00:02.000Z',
	infoHash: INFO_HASH.toUpperCase(),
	path: ['Book', '01.mp3'],
	processedMilliseconds: 2000,
	state: 'completed' as const,
	totalMilliseconds: 2000,
	trigger: 'automatic' as const,
	updatedAt: '2026-09-04T10:00:02.000Z',
}

describe('caption API client', () => {
	test('loads and updates the server-owned automatic transcription setting', async () => {
		const requests: Array<{
			body: string | null
			method: string
			url: string
		}> = []
		const client = new CaptionApiClient({
			fetcher: (input, init) => {
				requests.push({
					body: typeof init?.body === 'string' ? init.body : null,
					method: init?.method ?? 'GET',
					url: String(input),
				})
				return Promise.resolve(
					Response.json({
						automaticTranscription: init?.method === 'PUT',
						cleanupPending: init?.method === 'PUT',
					})
				)
			},
		})

		expect(await client.getSettings()).toEqual({
			automaticTranscription: false,
			cleanupPending: false,
		})
		expect(await client.updateSettings(true)).toEqual({
			automaticTranscription: true,
			cleanupPending: true,
		})
		expect(requests).toEqual([
			{ body: null, method: 'GET', url: '/api/settings/transcription' },
			{
				body: JSON.stringify({ automaticTranscription: true }),
				method: 'PUT',
				url: '/api/settings/transcription',
			},
		])
	})

	test('normalizes completed file status and preserves progress metadata', async () => {
		const client = new CaptionApiClient({
			fetcher: async () => Response.json(completedStatus),
		})

		expect(await client.getStatus(INFO_HASH.toUpperCase(), '7')).toEqual({
			...completedStatus,
			fileId: '7',
			infoHash: INFO_HASH,
		})
	})

	test('preserves queue and watchdog diagnostics from running jobs', async () => {
		const status = {
			...completedStatus,
			captions: undefined,
			finishedAt: undefined,
			processedMilliseconds: 90_000,
			queueBlockedByCleanup: true,
			queuedAhead: 2,
			queuePosition: 3,
			state: 'transcribing' as const,
			totalMilliseconds: undefined,
			watchdogDeadlineAt: '2026-09-04T10:10:00.000Z',
			watchdogRemainingMilliseconds: 120_000,
		}
		const client = new CaptionApiClient({
			fetcher: async () => Response.json(status),
		})

		expect(await client.getStatus(INFO_HASH, '7')).toMatchObject({
			queueBlockedByCleanup: true,
			queuedAhead: 2,
			queuePosition: 3,
			watchdogDeadlineAt: '2026-09-04T10:10:00.000Z',
			watchdogRemainingMilliseconds: 120_000,
		})
	})

	test('preserves a server-owned cleanup quarantine on terminal jobs', async () => {
		const client = new CaptionApiClient({
			fetcher: async () =>
				Response.json({
					...completedStatus,
					captions: undefined,
					cleanupPending: true,
					state: 'cancelled',
				}),
		})

		expect(await client.getStatus(INFO_HASH, '7')).toMatchObject({
			cleanupPending: true,
			state: 'cancelled',
		})
	})

	test('drops malformed queue and watchdog diagnostics', async () => {
		const client = new CaptionApiClient({
			fetcher: async () =>
				Response.json({
					...completedStatus,
					cleanupPending: 'yes',
					queueBlockedByCleanup: 'yes',
					queuedAhead: -1,
					queuePosition: 0,
					watchdogDeadlineAt: 'not-a-date',
					watchdogRemainingMilliseconds: -1,
				}),
		})

		const status = await client.getStatus(INFO_HASH, '7')
		expect(status).not.toHaveProperty('queuedAhead')
		expect(status).not.toHaveProperty('cleanupPending')
		expect(status).not.toHaveProperty('queueBlockedByCleanup')
		expect(status).not.toHaveProperty('queuePosition')
		expect(status).not.toHaveProperty('watchdogDeadlineAt')
		expect(status).not.toHaveProperty('watchdogRemainingMilliseconds')
	})

	test('conditionally transfers exact caption bytes and handles 304', async () => {
		const bytes = Uint8Array.from([0x54, 0x43, 0x41, 0x50])
		const requestHeaders: string[] = []
		let requestCount = 0
		const client = new CaptionApiClient({
			fetcher: (_input, init) => {
				requestCount += 1
				const headers = new Headers(init?.headers)
				requestHeaders.push(headers.get('if-none-match') ?? '')
				if (requestCount === 2) {
					return Promise.resolve(
						new Response(null, {
							headers: {
								'X-TPlayer-Caption-Updated-At': '2026-09-04T10:00:03.000Z',
							},
							status: 304,
						})
					)
				}
				return Promise.resolve(
					new Response(bytes, {
						headers: {
							'Content-Type': 'application/vnd.tplayer.captions',
							ETag: '"tcap-one"',
							'X-TPlayer-Caption-Updated-At': '2026-09-04T10:00:01.000Z',
						},
					})
				)
			},
		})

		const downloaded = await client.getTrack(INFO_HASH, '7', undefined)
		expect(downloaded.kind).toBe('track')
		if (downloaded.kind === 'track') {
			expect(downloaded.artifactUpdatedAt).toBe('2026-09-04T10:00:01.000Z')
			expect(new Uint8Array(downloaded.bytes)).toEqual(bytes)
			expect(downloaded.etag).toBe('"tcap-one"')
		}
		expect(await client.getTrack(INFO_HASH, '7', '"tcap-one"')).toEqual({
			artifactUpdatedAt: '2026-09-04T10:00:03.000Z',
			kind: 'not-modified',
		})
		expect(requestHeaders).toEqual(['', '"tcap-one"'])
	})

	test('surfaces structured failures and treats missing jobs as unavailable', async () => {
		let requestCount = 0
		const client = new CaptionApiClient({
			fetcher: () => {
				requestCount += 1
				if (requestCount === 1) {
					return Promise.resolve(
						Response.json({ error: { code: 'missing' } }, { status: 404 })
					)
				}
				return Promise.resolve(
					Response.json(
						{
							error: {
								code: 'provider_unavailable',
								message: 'CouchSpeech is unavailable',
							},
						},
						{ status: 503 }
					)
				)
			},
		})

		expect(await client.getStatus(INFO_HASH, '7')).toBeNull()
		await expect(client.start(INFO_HASH, '7')).rejects.toEqual(
			new CaptionApiError(
				503,
				'provider_unavailable',
				'CouchSpeech is unavailable'
			)
		)
	})
})

import { describe, expect, test } from 'bun:test'
import { createApp } from '../app'
import { PrivateSwarmHarness, readResponse } from '../test/harness'
import { AudiobookSearchService, createAudiobookSearchService } from './service'
import { SearchUpstreamHarness } from './test/upstream'
import type { AudiobookProvider, AudiobookSearchResponse } from './types'

const INTEGRATION_TIMEOUT_MS = 30_000

describe('audiobook provider integration', () => {
	test(
		'searches real HTTP adapters, keeps trackers opt-in, resolves both catalogs, and streams exact torrent bytes',
		async () => {
			const torrentHarness = await PrivateSwarmHarness.start()
			let upstream: SearchUpstreamHarness | undefined
			try {
				upstream = SearchUpstreamHarness.start(
					torrentHarness.infoHash,
					'Private swarm audiobook'
				)
				const searchService = createAudiobookSearchService({
					endpoints: upstream.endpoints,
				})
				const app = createApp({
					config: torrentHarness.config,
					database: torrentHarness.database,
					logger: {
						debug: () => undefined,
						error: () => undefined,
						info: () => undefined,
						warn: () => undefined,
					},
					manager: torrentHarness.manager,
					searchService,
					serveFrontend: false,
				})

				expect((await app.request('/api/search')).status).toBe(400)
				expect(
					(
						await app.request(
							`/api/search?q=${encodeURIComponent('x'.repeat(161))}`
						)
					).status
				).toBe(422)
				expect(
					(await app.request('/api/search?q=book&providers=removed-provider'))
						.status
				).toBe(422)
				expect(
					(
						await app.request('/api/search/resolve', {
							body: '{',
							headers: { 'Content-Type': 'application/json' },
							method: 'POST',
						})
					).status
				).toBe(400)
				expect(
					(
						await app.request('/api/search/resolve', {
							body: 'null',
							headers: { 'Content-Type': 'application/json' },
							method: 'POST',
						})
					).status
				).toBe(400)
				expect(
					(
						await app.request('/api/search/resolve', {
							body: JSON.stringify({
								providerId: 'removed-provider',
								resultId: 'book',
							}),
							headers: { 'Content-Type': 'application/json' },
							method: 'POST',
						})
					).status
				).toBe(422)
				expect(
					(
						await app.request('/api/search/resolve', {
							body: JSON.stringify({
								providerId: 'librivox',
								resultId: 'x'.repeat(9000),
							}),
							headers: { 'Content-Type': 'application/json' },
							method: 'POST',
						})
					).status
				).toBe(413)
				expect(upstream.snapshot()).toEqual({
					archiveMetadataRequests: 0,
					audiobookBayDetailRequests: 0,
					audiobookBaySearchRequests: 0,
					internetArchiveSearchRequests: 0,
					librivoxSearchRequests: 0,
				})

				const providersResponse = await app.request('/api/search/providers')
				expect(providersResponse.status).toBe(200)
				const providerPayload = (await providersResponse.json()) as {
					providers: Array<{
						defaultEnabled: boolean
						id: string
						kind: string
						rights: string
					}>
				}
				expect(providerPayload.providers).toEqual(
					expect.arrayContaining([
						expect.objectContaining({
							defaultEnabled: true,
							id: 'librivox',
							kind: 'free',
							rights: 'public-domain-source',
						}),
						expect.objectContaining({
							id: 'internet-archive',
							rights: 'rights-labelled-source',
						}),
						expect.objectContaining({
							defaultEnabled: false,
							id: 'audiobook-bay',
							kind: 'tracker',
							rights: 'unverified-third-party',
						}),
					])
				)

				const freeResponse = await app.request('/api/search?q=private%20swarm')
				expect(freeResponse.status).toBe(200)
				const freeSearch =
					(await freeResponse.json()) as AudiobookSearchResponse
				expect(freeSearch.results.map(({ providerId }) => providerId)).toEqual([
					'librivox',
					'internet-archive',
				])
				expect(freeSearch.results[0]?.description).toBe(
					'A public-domain fixture from LibriVox.'
				)
				expect(
					freeSearch.results.find(
						({ providerId }) => providerId === 'internet-archive'
					)?.rightsUrl
				).toBe('https://creativecommons.org/licenses/by/4.0/')
				expect(upstream.snapshot().audiobookBaySearchRequests).toBe(0)

				const allResponse = await app.request(
					'/api/search?q=private%20swarm&providers=audiobook-bay'
				)
				const allSearch = (await allResponse.json()) as AudiobookSearchResponse
				expect(allSearch.results.map(({ providerId }) => providerId)).toEqual([
					'librivox',
					'internet-archive',
					'audiobook-bay',
				])
				expect(upstream.snapshot().audiobookBaySearchRequests).toBe(1)

				const freeResult = allSearch.results.find(
					({ providerId }) => providerId === 'librivox'
				)
				expect(freeResult).toBeDefined()
				const resolveResponse = await app.request('/api/search/resolve', {
					body: JSON.stringify({
						providerId: freeResult?.providerId,
						resultId: freeResult?.id,
					}),
					headers: { 'Content-Type': 'application/json' },
					method: 'POST',
				})
				expect(resolveResponse.status).toBe(202)
				expect(await resolveResponse.json()).toMatchObject({
					backgroundDownload: true,
					infoHash: torrentHarness.infoHash,
				})
				expect(
					torrentHarness.database.listTorrentRegistrations()
				).toContainEqual({
					backgroundDownload: true,
					infoHash: torrentHarness.infoHash,
					torrentId: expect.any(String),
				})

				const archiveResult = allSearch.results.find(
					({ providerId }) => providerId === 'internet-archive'
				)
				expect(archiveResult).toBeDefined()
				const archiveResolveResponse = await app.request(
					'/api/search/resolve',
					{
						body: JSON.stringify({
							providerId: archiveResult?.providerId,
							resultId: archiveResult?.id,
						}),
						headers: { 'Content-Type': 'application/json' },
						method: 'POST',
					}
				)
				expect(archiveResolveResponse.status).toBe(202)
				expect(await archiveResolveResponse.json()).toMatchObject({
					infoHash: torrentHarness.infoHash,
				})

				const detailsResponse = await app.request(
					`/api/torrents/${torrentHarness.infoHash}`
				)
				if (!detailsResponse.ok) {
					throw new Error(
						`Resolved torrent metadata failed with ${detailsResponse.status}: ${await detailsResponse.text()}; torrent logs: ${torrentHarness.errors.join(' | ')}`
					)
				}
				const details = (await detailsResponse.json()) as {
					files: Array<{ id: string; path: string[] }>
				}
				const [fixtureFile] = torrentHarness.fixture.files
				const file = details.files.find(
					(candidate) => candidate.path.join('/') === fixtureFile?.path
				)
				expect(file).toBeDefined()
				const rangeEnd = 4095
				const audioResponse = await app.request(
					`/api/torrents/${torrentHarness.infoHash}/files/${file?.id}`,
					{ headers: { Range: `bytes=0-${rangeEnd}` } }
				)
				const audio = await readResponse(audioResponse)
				expect(audioResponse.status).toBe(206)
				expect(audio.body).toEqual(fixtureFile?.bytes.slice(0, rangeEnd + 1))

				const trackerResult = allSearch.results.find(
					({ providerId }) => providerId === 'audiobook-bay'
				)
				const trackerResponse = await app.request('/api/search/resolve', {
					body: JSON.stringify({
						providerId: trackerResult?.providerId,
						resultId: trackerResult?.id,
					}),
					headers: { 'Content-Type': 'application/json' },
					method: 'POST',
				})
				expect(trackerResponse.status).toBe(202)
				expect(await trackerResponse.json()).toMatchObject({
					infoHash: torrentHarness.infoHash,
				})
				expect(upstream.snapshot().audiobookBayDetailRequests).toBe(1)
			} finally {
				try {
					upstream?.close()
				} finally {
					await torrentHarness.close()
				}
			}
		},
		INTEGRATION_TIMEOUT_MS
	)

	test(
		'isolates an upstream failure and reports it beside usable results',
		async () => {
			const upstream = SearchUpstreamHarness.start(
				'a'.repeat(40),
				'Provider outage fixture'
			)
			const searchService = createAudiobookSearchService({
				endpoints: upstream.endpoints,
			})
			try {
				const response = await searchService.search('archive outage', new Set())
				expect(
					response.results.some(({ providerId }) => providerId === 'librivox')
				).toBe(true)
				expect(response.providers).toContainEqual({
					count: 0,
					error: 'Internet Archive is temporarily unavailable',
					id: 'internet-archive',
					label: 'Internet Archive',
					state: 'error',
				})
			} finally {
				upstream.close()
			}
		},
		INTEGRATION_TIMEOUT_MS
	)

	test('rejects a resolution that completes after its request is cancelled', async () => {
		const controller = new AbortController()
		const provider: AudiobookProvider = {
			descriptor: {
				defaultEnabled: true,
				homepage: 'https://librivox.org',
				id: 'librivox',
				kind: 'free',
				label: 'LibriVox',
				rights: 'public-domain-source',
			},
			resolve: () => {
				controller.abort()
				return Promise.resolve('a'.repeat(40))
			},
			search: () => Promise.resolve([]),
		}
		const service = new AudiobookSearchService([provider])
		await expect(
			service.resolve('librivox', 'cancelled-book', {
				signal: controller.signal,
			})
		).rejects.toMatchObject({ code: 'request_cancelled', status: 499 })
	})
})

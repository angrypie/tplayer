import { describe, expect, spyOn, test } from 'bun:test'
import {
	mkdir,
	open as openFileHandle,
	realpath,
	stat,
	truncate,
} from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { reportBenchmark } from '../test/benchmark'
import {
	delay,
	PrivateSwarmHarness,
	readResponse,
	sha256,
} from '../test/harness'
import type { PreloadStatus, TorrentStatus } from './manager'

const MIB = 1024 * 1024
const INTEGRATION_TIMEOUT_MS = 30_000

const requiredFileId = (id: string | undefined, path: string): string => {
	if (id === undefined) {
		throw new Error(`No torrent file id was assigned for ${path}`)
	}
	return id
}

const fileUrl = (harness: PrivateSwarmHarness, fileId: string): string =>
	`/api/torrents/${harness.infoHash}/files/${fileId}`

const readRange = async (
	harness: PrivateSwarmHarness,
	fileId: string,
	range: string
): Promise<{ body: Uint8Array; response: Response }> => {
	const response = await harness.app.request(fileUrl(harness, fileId), {
		headers: { Range: range },
	})
	const { body } = await readResponse(response)
	return { body, response }
}

const waitForPreload = async (
	harness: PrivateSwarmHarness,
	url: string,
	observedBytes: number[],
	previousBytes = 0,
	polls = 0
): Promise<PreloadStatus> => {
	if (polls >= 2000) {
		throw new Error('Preload did not complete after 20 seconds')
	}
	await delay(10)
	const response = await harness.app.request(url)
	if (!response.ok) {
		throw new Error(`Preload status returned ${response.status}`)
	}
	const status = (await response.json()) as PreloadStatus
	if (status.downloadedBytes < previousBytes) {
		throw new Error(
			`Preload progress moved backwards from ${previousBytes} to ${status.downloadedBytes}`
		)
	}
	observedBytes.push(status.downloadedBytes)
	return status.state === 'running'
		? await waitForPreload(
				harness,
				url,
				observedBytes,
				status.downloadedBytes,
				polls + 1
			)
		: status
}

const waitForTorrentStatus = async (
	harness: PrivateSwarmHarness,
	url: string,
	observedProgress: number[],
	previousProgress = 0,
	polls = 0
): Promise<TorrentStatus> => {
	if (polls >= 2000) {
		throw new Error(
			'Background torrent download did not complete after 20 seconds'
		)
	}
	await delay(10)
	const response = await harness.app.request(url)
	if (!response.ok) {
		throw new Error(`Torrent status returned ${response.status}`)
	}
	const status = (await response.json()) as TorrentStatus
	if (status.progress < previousProgress) {
		throw new Error(
			`Torrent progress moved backwards from ${previousProgress} to ${status.progress}`
		)
	}
	observedProgress.push(status.progress)
	return status.state === 'fetching_metadata' || status.state === 'downloading'
		? await waitForTorrentStatus(
				harness,
				url,
				observedProgress,
				status.progress,
				polls + 1
			)
		: status
}

const waitForPartialTorrentStatus = async (
	harness: PrivateSwarmHarness,
	url: string,
	polls = 0
): Promise<TorrentStatus> => {
	if (polls >= 1000) {
		throw new Error('Background torrent did not report partial progress')
	}
	await delay(10)
	const response = await harness.app.request(url)
	if (!response.ok) {
		throw new Error(`Torrent status returned ${response.status}`)
	}
	const status = (await response.json()) as TorrentStatus
	if (
		status.state === 'downloading' &&
		status.downloadedBytes > 0 &&
		status.downloadedBytes < status.totalBytes
	) {
		return status
	}
	return await waitForPartialTorrentStatus(harness, url, polls + 1)
}

const waitForCacheEviction = async (
	harness: PrivateSwarmHarness,
	infoHash: string,
	polls = 0
): Promise<void> => {
	if (harness.database.getCacheEntry(infoHash) === null) {
		return
	}
	if (polls >= 1000) {
		throw new Error('Torrent cache entry was not evicted after 10 seconds')
	}
	await delay(10)
	await waitForCacheEviction(harness, infoHash, polls + 1)
}

describe('Hono and WebTorrent private swarm integration', () => {
	test(
		'serves exact full, closed, open, suffix, single-byte, concurrent, invalid, and HEAD ranges',
		async () => {
			const harness = await PrivateSwarmHarness.start()
			try {
				await harness.register()
				const legacyShellList = await harness.app.request('/api/torrents')
				expect(legacyShellList.headers.get('clear-site-data')).toBe('"cache"')
				const currentShellList = await harness.app.request('/api/torrents', {
					headers: { 'X-TPlayer-App-Shell': '2' },
				})
				expect(currentShellList.headers.get('clear-site-data')).toBeNull()
				const legacyShellRegistration = await harness.app.request(
					'/api/torrents',
					{
						body: JSON.stringify({ torrentId: harness.infoHash }),
						headers: { 'Content-Type': 'application/json' },
						method: 'POST',
					}
				)
				expect(legacyShellRegistration.status).toBe(202)
				expect(legacyShellRegistration.headers.get('clear-site-data')).toBe(
					'"cache"'
				)
				expect(await legacyShellRegistration.json()).toMatchObject({
					backgroundDownload: false,
				})
				const currentShellRegistration = await harness.app.request(
					'/api/torrents',
					{
						body: JSON.stringify({
							download: false,
							torrentId: harness.infoHash,
						}),
						headers: {
							'Content-Type': 'application/json',
							'X-TPlayer-App-Shell': '2',
						},
						method: 'POST',
					}
				)
				expect(currentShellRegistration.status).toBe(202)
				expect(
					currentShellRegistration.headers.get('clear-site-data')
				).toBeNull()
				const [fixtureFile] = harness.fixture.files
				if (!fixtureFile) {
					throw new Error('Private swarm fixture has no primary audio file')
				}
				const id = requiredFileId(fixtureFile.id, fixtureFile.path)
				const url = fileUrl(harness, id)
				const torrent = await harness.torrent()
				expect(torrent.downloaded).toBe(0)

				const head = await harness.app.request(url, { method: 'HEAD' })
				expect(head.status).toBe(200)
				expect(head.headers.get('accept-ranges')).toBe('bytes')
				expect(head.headers.get('content-length')).toBe(
					String(fixtureFile.bytes.byteLength)
				)
				expect(head.headers.get('content-type')).toBe('audio/wav')
				expect((await head.arrayBuffer()).byteLength).toBe(0)

				const rangeHeadStart = 101
				const rangeHeadEnd = 200
				const rangeHead = await harness.app.request(url, {
					headers: { Range: `bytes=${rangeHeadStart}-${rangeHeadEnd}` },
					method: 'HEAD',
				})
				expect(rangeHead.status).toBe(206)
				expect(rangeHead.headers.get('content-range')).toBe(
					`bytes ${rangeHeadStart}-${rangeHeadEnd}/${fixtureFile.bytes.byteLength}`
				)
				expect(rangeHead.headers.get('content-length')).toBe('100')
				expect((await rangeHead.arrayBuffer()).byteLength).toBe(0)
				expect(torrent.downloaded).toBe(0)

				const firstByte = await readRange(harness, id, 'bytes=0-0')
				expect(firstByte.response.status).toBe(206)
				expect(firstByte.response.headers.get('content-range')).toBe(
					`bytes 0-0/${fixtureFile.bytes.byteLength}`
				)
				expect(firstByte.response.headers.get('content-length')).toBe('1')
				expect(firstByte.body).toEqual(fixtureFile.bytes.slice(0, 1))

				const closedStart = 127_013
				const closedEnd = 1_310_921
				const closed = await readRange(
					harness,
					id,
					`bytes=${closedStart}-${closedEnd}`
				)
				expect(closed.response.status).toBe(206)
				expect(closed.response.headers.get('content-range')).toBe(
					`bytes ${closedStart}-${closedEnd}/${fixtureFile.bytes.byteLength}`
				)
				expect(closed.response.headers.get('content-length')).toBe(
					String(closedEnd - closedStart + 1)
				)
				expect(closed.body).toEqual(
					fixtureFile.bytes.slice(closedStart, closedEnd + 1)
				)

				const openStart = fixtureFile.bytes.byteLength - 98_317
				const open = await readRange(harness, id, `bytes=${openStart}-`)
				expect(open.response.status).toBe(206)
				expect(open.response.headers.get('content-range')).toBe(
					`bytes ${openStart}-${fixtureFile.bytes.byteLength - 1}/${fixtureFile.bytes.byteLength}`
				)
				expect(open.response.headers.get('content-length')).toBe(
					String(fixtureFile.bytes.byteLength - openStart)
				)
				expect(open.body).toEqual(fixtureFile.bytes.slice(openStart))

				const suffixLength = 73_919
				const suffix = await readRange(harness, id, `bytes=-${suffixLength}`)
				expect(suffix.response.status).toBe(206)
				expect(suffix.response.headers.get('content-range')).toBe(
					`bytes ${fixtureFile.bytes.byteLength - suffixLength}-${fixtureFile.bytes.byteLength - 1}/${fixtureFile.bytes.byteLength}`
				)
				expect(suffix.response.headers.get('content-length')).toBe(
					String(suffixLength)
				)
				expect(suffix.body).toEqual(fixtureFile.bytes.slice(-suffixLength))

				const concurrentRanges = [
					{ end: 1_900_123, start: 900_001 },
					{ end: 2_400_321, start: 1_100_007 },
					{ end: 3_200_999, start: 2_000_111 },
					{ end: 3_600_555, start: 2_500_333 },
				]
				const concurrent = await Promise.all(
					concurrentRanges.map(async ({ end, start }) => {
						const result = await readRange(harness, id, `bytes=${start}-${end}`)
						return { ...result, end, start }
					})
				)
				for (const result of concurrent) {
					expect(result.response.status).toBe(206)
					expect(result.response.headers.get('content-range')).toBe(
						`bytes ${result.start}-${result.end}/${fixtureFile.bytes.byteLength}`
					)
					expect(result.response.headers.get('content-length')).toBe(
						String(result.end - result.start + 1)
					)
					expect(result.body).toEqual(
						fixtureFile.bytes.slice(result.start, result.end + 1)
					)
				}

				const invalid = await harness.app.request(url, {
					headers: {
						Range: `bytes=${fixtureFile.bytes.byteLength}-`,
					},
				})
				expect(invalid.status).toBe(416)
				expect(invalid.headers.get('content-range')).toBe(
					`bytes */${fixtureFile.bytes.byteLength}`
				)
				const invalidBody = (await invalid.json()) as {
					error: { code: string }
				}
				expect(invalidBody.error.code).toBe('invalid_range')

				const multiple = await harness.app.request(url, {
					headers: { Range: 'bytes=0-1,4-5' },
				})
				expect(multiple.status).toBe(416)
				expect(multiple.headers.get('content-range')).toBe(
					`bytes */${fixtureFile.bytes.byteLength}`
				)

				const fullResponse = await harness.app.request(url)
				const full = await readResponse(fullResponse)
				expect(fullResponse.status).toBe(200)
				expect(fullResponse.headers.get('content-range')).toBeNull()
				expect(fullResponse.headers.get('accept-ranges')).toBe('bytes')
				expect(fullResponse.headers.get('content-length')).toBe(
					String(fixtureFile.bytes.byteLength)
				)
				expect(fullResponse.headers.get('content-type')).toBe('audio/wav')
				expect(full.body.byteLength).toBe(fixtureFile.bytes.byteLength)
				expect(sha256(full.body)).toBe(fixtureFile.sha256)
			} finally {
				await harness.close()
			}
		},
		INTEGRATION_TIMEOUT_MS
	)

	test(
		'opens one fully cached chapter from an incomplete idle torrent and reports retained progress',
		async () => {
			const harness = await PrivateSwarmHarness.start(75)
			try {
				await harness.register()
				const [primaryFixture, secondaryFixture] = harness.fixture.files
				if (!(primaryFixture && secondaryFixture)) {
					throw new Error('Private swarm fixture has too few audio files')
				}
				const primaryFileId = requiredFileId(
					primaryFixture.id,
					primaryFixture.path
				)
				const secondaryFileId = requiredFileId(
					secondaryFixture.id,
					secondaryFixture.path
				)

				const response = await harness.app.request(
					fileUrl(harness, primaryFileId)
				)
				const { body } = await readResponse(response)
				expect(response.status).toBe(200)
				expect(sha256(body)).toBe(primaryFixture.sha256)
				await harness.waitForIdleDrop()

				const cache = harness.database.getCacheEntry(harness.infoHash)
				if (!cache) {
					throw new Error('Partial torrent cache was not retained')
				}
				expect(cache.completed).toBe(false)
				const statusUrl = `/api/torrents/${harness.infoHash}/status`
				const statusResponse = await harness.app.request(statusUrl)
				const status = (await statusResponse.json()) as TorrentStatus
				expect(status.state).toBe('idle')
				expect(status.totalBytes).toBe(harness.fixture.totalBytes)
				expect(status.downloadedBytes).toBe(
					Math.min(cache.bytes, harness.fixture.totalBytes)
				)
				expect(status.progress).toBeGreaterThan(0)
				expect(status.progress).toBeLessThan(1)
				const listed = (await (
					await harness.app.request('/api/torrents')
				).json()) as TorrentStatus[]
				expect(
					listed.find((torrent) => torrent.infoHash === harness.infoHash)
				).toMatchObject({
					downloadedBytes: status.downloadedBytes,
					totalBytes: harness.fixture.totalBytes,
				})

				expect(
					await harness.manager.cachedFile(harness.infoHash, primaryFileId)
				).toMatchObject({ id: primaryFileId, progress: 1 })
				await expect(
					harness.manager.cachedFiles(harness.infoHash)
				).rejects.toMatchObject({ code: 'audio_not_local', status: 409 })

				const storedFiles = harness.database.listTorrentFiles(harness.infoHash)
				const primaryStored = storedFiles.find(
					(file) => file.fileId === primaryFileId
				)
				const secondaryStored = storedFiles.find(
					(file) => file.fileId === secondaryFileId
				)
				if (!(primaryStored && secondaryStored)) {
					throw new Error('Stored torrent manifest omitted an audio file')
				}
				const opened = await harness.manager.openCachedFile(
					harness.infoHash,
					primaryFileId
				)
				const expectedLocalPath = await realpath(
					join(
						harness.config.torrent.cacheDirectory,
						harness.infoHash,
						...primaryStored.storagePath
					)
				)
				expect(opened.localPath).toBe(expectedLocalPath)
				if (!opened.stream) {
					throw new Error('Fully cached chapter had no stream')
				}
				const openedBody = new Uint8Array(
					await new Response(opened.stream).arrayBuffer()
				)
				await opened.released
				expect(sha256(openedBody)).toBe(primaryFixture.sha256)

				const sparsePath = join(
					harness.config.torrent.cacheDirectory,
					harness.infoHash,
					...secondaryStored.storagePath
				)
				await mkdir(dirname(sparsePath), { recursive: true })
				await (await openFileHandle(sparsePath, 'w')).close()
				await truncate(sparsePath, secondaryStored.length)
				const sparseStat = await stat(sparsePath)
				expect(sparseStat.size).toBe(secondaryStored.length)
				expect(sparseStat.blocks * 512).toBeLessThan(secondaryStored.length)
				await expect(
					harness.manager.cachedFile(harness.infoHash, secondaryFileId)
				).rejects.toMatchObject({ code: 'audio_not_local', status: 409 })
			} finally {
				await harness.close()
			}
		},
		INTEGRATION_TIMEOUT_MS
	)

	test(
		'preloads once, reports real progress, survives idle eviction, and serves the complete cache after restart without a seed',
		async () => {
			const harness = await PrivateSwarmHarness.start(75)
			try {
				await harness.register()
				const [primaryFixture] = harness.fixture.files
				if (!primaryFixture) {
					throw new Error('Private swarm fixture has no primary audio file')
				}
				const primaryFileId = requiredFileId(
					primaryFixture.id,
					primaryFixture.path
				)
				await expect(
					harness.manager.openCachedFile(harness.infoHash, primaryFileId)
				).rejects.toMatchObject({ code: 'audio_not_local' })
				const completedHashes: string[] = []
				const stopObserving = harness.manager.onCacheCompleted((infoHash) => {
					completedHashes.push(infoHash)
				})
				const preloadUrl = `/api/torrents/${harness.infoHash}/preload`
				const [firstResponse, secondResponse] = await Promise.all([
					harness.app.request(preloadUrl, { method: 'POST' }),
					harness.app.request(preloadUrl, { method: 'POST' }),
				])
				expect(firstResponse.status).toBe(202)
				expect(secondResponse.status).toBe(202)
				const first = (await firstResponse.json()) as PreloadStatus
				const second = (await secondResponse.json()) as PreloadStatus
				expect(first.startedAt).toBe(second.startedAt)

				const observedBytes: number[] = []
				const status =
					first.state === 'running'
						? await waitForPreload(harness, preloadUrl, observedBytes)
						: first
				expect(status.state).toBe('completed')
				expect(status.totalBytes).toBe(harness.fixture.totalBytes)
				expect(status.downloadedBytes).toBe(harness.fixture.totalBytes)
				expect(
					observedBytes.some(
						(downloaded) => downloaded > 0 && downloaded < status.totalBytes
					)
				).toBe(true)
				expect((await harness.torrent()).done).toBe(true)
				expect(completedHashes).toContain(harness.infoHash)
				stopObserving()

				await harness.stopSeeder()
				await harness.waitForIdleDrop()
				expect(harness.manager.health().activeSessions).toBe(0)
				harness.database.connection
					.query('DELETE FROM torrent_files WHERE info_hash = ?')
					.run(harness.infoHash)
				await harness.restartWithoutSeeder()
				const opened = await harness.manager.openCachedFile(
					harness.infoHash,
					primaryFileId
				)
				const locallyOpened = new Uint8Array(
					await new Response(opened.stream).arrayBuffer()
				)
				expect(sha256(locallyOpened)).toBe(primaryFixture.sha256)
				expect(
					harness.database.listTorrentFiles(harness.infoHash)
				).toHaveLength(harness.fixture.files.length)
				expect(harness.manager.health().activeSessions).toBe(0)

				const cachedFiles = await Promise.all(
					harness.fixture.files.map(async (fixtureFile) => {
						const id = requiredFileId(fixtureFile.id, fixtureFile.path)
						const response = await harness.app.request(fileUrl(harness, id))
						const { body } = await readResponse(response)
						return { body, fixtureFile, response }
					})
				)
				for (const { body, fixtureFile, response } of cachedFiles) {
					expect(response.status).toBe(200)
					expect(body.byteLength).toBe(fixtureFile.bytes.byteLength)
					expect(sha256(body)).toBe(fixtureFile.sha256)
				}
				expect((await harness.torrent()).received).toBe(0)
			} finally {
				await harness.close()
			}
		},
		INTEGRATION_TIMEOUT_MS
	)

	test(
		'keeps a direct-cache transcription reader leased across capacity pruning',
		async () => {
			const harness = await PrivateSwarmHarness.start(250)
			try {
				harness.config.torrent.cacheCapacityBytes = 1
				await harness.register(true)
				const statusUrl = `/api/torrents/${harness.infoHash}/status`
				const initialResponse = await harness.app.request(statusUrl)
				const initial = (await initialResponse.json()) as TorrentStatus
				const completed =
					initial.state === 'completed'
						? initial
						: await waitForTorrentStatus(
								harness,
								statusUrl,
								[],
								initial.progress
							)
				expect(completed.state).toBe('completed')
				const [fixtureFile] = harness.fixture.files
				if (!fixtureFile) {
					throw new Error('Private swarm fixture has no transcription file')
				}
				const fileId = requiredFileId(fixtureFile.id, fixtureFile.path)
				const opened = await harness.manager.openCachedFile(
					harness.infoHash,
					fileId
				)
				if (!opened.stream) {
					throw new Error('Cached transcription file had no stream')
				}
				const reader = opened.stream.getReader()
				try {
					await harness.waitForIdleDrop()
					await delay(50)
					expect(
						harness.database.getCacheEntry(harness.infoHash)
					).not.toBeNull()
					const first = await reader.read()
					expect(first.done).toBe(false)
					expect(first.value?.byteLength).toBeGreaterThan(0)
				} finally {
					await reader.cancel()
				}
				await waitForCacheEviction(harness, harness.infoHash)
				expect(harness.database.getCacheEntry(harness.infoHash)).toBeNull()
			} finally {
				await harness.close()
			}
		},
		INTEGRATION_TIMEOUT_MS
	)

	test(
		'waits for a direct-cache reader to close before removing its torrent',
		async () => {
			const harness = await PrivateSwarmHarness.start(75)
			try {
				await harness.register(true)
				const statusUrl = `/api/torrents/${harness.infoHash}/status`
				const initialResponse = await harness.app.request(statusUrl)
				const initial = (await initialResponse.json()) as TorrentStatus
				if (initial.state !== 'completed') {
					await waitForTorrentStatus(harness, statusUrl, [], initial.progress)
				}
				await harness.waitForIdleDrop()
				const [fixtureFile] = harness.fixture.files
				if (!fixtureFile) {
					throw new Error('Private swarm fixture has no transcription file')
				}
				const fileId = requiredFileId(fixtureFile.id, fixtureFile.path)
				const opened = await harness.manager.openCachedFile(
					harness.infoHash,
					fileId
				)
				if (!opened.stream) {
					throw new Error('Cached transcription file had no stream')
				}
				const reader = opened.stream.getReader()
				let removalSettled = false
				let reservedBeforeCallback = false
				const removal = harness.manager
					.remove(harness.infoHash, () => {
						reservedBeforeCallback = harness.manager.isRemoving(
							harness.infoHash
						)
						return Promise.resolve()
					})
					.finally(() => {
						removalSettled = true
					})
				try {
					await delay(50)
					expect(reservedBeforeCallback).toBe(true)
					expect(removalSettled).toBe(false)
					expect(harness.database.getMetadata(harness.infoHash)).not.toBeNull()
					await expect(
						harness.manager.openCachedFile(harness.infoHash, fileId)
					).rejects.toMatchObject({ code: 'torrent_removing', status: 409 })
				} finally {
					await reader.cancel()
				}
				expect(await removal).toBe(true)
				expect(harness.database.getMetadata(harness.infoHash)).toBeNull()
			} finally {
				await harness.close()
			}
		},
		INTEGRATION_TIMEOUT_MS
	)

	test(
		'registers and completes a page-independent background download when explicitly requested',
		async () => {
			const harness = await PrivateSwarmHarness.start()
			try {
				await harness.register(true)
				const statusUrl = `/api/torrents/${harness.infoHash}/status`
				const initialResponse = await harness.app.request(statusUrl)
				expect(initialResponse.status).toBe(200)
				const initial = (await initialResponse.json()) as TorrentStatus
				expect(initial.metadataReady).toBe(true)
				expect(['downloading', 'completed'].includes(initial.state)).toBe(true)
				expect(initial.name).toBe(harness.seedTorrent.name)
				expect(initial.startedAt).toBeString()

				const listResponse = await harness.app.request('/api/torrents')
				const listed = (await listResponse.json()) as TorrentStatus[]
				const listedTorrent = listed.find(
					(torrent) => torrent.infoHash === harness.infoHash
				)
				expect(listedTorrent?.metadataReady).toBe(true)
				expect(listedTorrent?.state).not.toBe('idle')

				const observedProgress: number[] = []
				const completed =
					initial.state === 'completed'
						? initial
						: await waitForTorrentStatus(
								harness,
								statusUrl,
								observedProgress,
								initial.progress
							)
				expect(completed.state).toBe('completed')
				expect(completed.progress).toBe(1)
				expect(completed.downloadedBytes).toBe(harness.fixture.totalBytes)
				expect(completed.totalBytes).toBe(harness.fixture.totalBytes)
				await harness.waitForIdleDrop()

				await harness.stopSeeder()
				await harness.restartWithoutSeeder()
				const restartedResponse = await harness.app.request(statusUrl)
				expect(restartedResponse.status).toBe(200)
				const restarted = (await restartedResponse.json()) as TorrentStatus
				expect(restarted.state).toBe('completed')
				expect(restarted.metadataReady).toBe(true)
				expect(restarted.progress).toBe(1)
				expect(harness.manager.health().activeSessions).toBe(0)
				expect(harness.manager.health().preloadJobs).toBe(0)
			} finally {
				await harness.close()
			}
		},
		INTEGRATION_TIMEOUT_MS
	)

	test(
		'cancels and deletes a partially downloaded background torrent without waiting for peers',
		async () => {
			const harness = await PrivateSwarmHarness.start()
			try {
				harness.downloader.throttleDownload(512 * 1024)
				await harness.register(true)
				const statusUrl = `/api/torrents/${harness.infoHash}/status`
				const partial = await waitForPartialTorrentStatus(harness, statusUrl)
				expect(partial.progress).toBeGreaterThan(0)
				expect(partial.progress).toBeLessThan(1)

				await harness.stopSeeder()
				const deleteResponse = await Promise.race([
					harness.app.request(`/api/torrents/${harness.infoHash}`, {
						method: 'DELETE',
					}),
					delay(2000).then(() => {
						throw new Error('Active background torrent deletion timed out')
					}),
				])

				expect(deleteResponse.status).toBe(204)
				expect((await harness.app.request(statusUrl)).status).toBe(404)
				const listResponse = await harness.app.request('/api/torrents')
				const listed = (await listResponse.json()) as TorrentStatus[]
				expect(
					listed.some((torrent) => torrent.infoHash === harness.infoHash)
				).toBe(false)
				expect(harness.manager.health().activeSessions).toBe(0)
				expect(harness.manager.health().preloadJobs).toBe(0)
			} finally {
				await harness.close()
			}
		},
		INTEGRATION_TIMEOUT_MS
	)

	test(
		'preserves a torrent registration when WebTorrent removal fails so deletion can be retried',
		async () => {
			const harness = await PrivateSwarmHarness.start(
				INTEGRATION_TIMEOUT_MS * 2
			)
			try {
				await harness.register()
				const statusUrl = `/api/torrents/${harness.infoHash}/status`
				const removeSpy = spyOn(harness.downloader, 'remove')
				try {
					removeSpy.mockRejectedValueOnce(
						new Error('Injected WebTorrent remove failure')
					)

					const failedDelete = await harness.app.request(
						`/api/torrents/${harness.infoHash}`,
						{ method: 'DELETE' }
					)
					expect(failedDelete.status).toBe(500)
					expect(removeSpy).toHaveBeenCalledTimes(1)
					expect(harness.manager.isRemoving(harness.infoHash)).toBe(false)

					const retainedStatusResponse = await harness.app.request(statusUrl)
					expect(retainedStatusResponse.status).toBe(200)
					expect(await retainedStatusResponse.json()).toMatchObject({
						infoHash: harness.infoHash,
					})
					const retainedListResponse =
						await harness.app.request('/api/torrents')
					const retainedList =
						(await retainedListResponse.json()) as TorrentStatus[]
					expect(
						retainedList.some(
							(torrent) => torrent.infoHash === harness.infoHash
						)
					).toBe(true)

					const retriedDelete = await harness.app.request(
						`/api/torrents/${harness.infoHash}`,
						{ method: 'DELETE' }
					)
					expect(retriedDelete.status).toBe(204)
					expect(removeSpy).toHaveBeenCalledTimes(2)
					expect((await harness.app.request(statusUrl)).status).toBe(404)
					const deletedListResponse = await harness.app.request('/api/torrents')
					const deletedList =
						(await deletedListResponse.json()) as TorrentStatus[]
					expect(
						deletedList.some((torrent) => torrent.infoHash === harness.infoHash)
					).toBe(false)
				} finally {
					removeSpy.mockRestore()
				}
			} finally {
				await harness.close()
			}
		},
		INTEGRATION_TIMEOUT_MS
	)

	test(
		'downgrades completed status after the bounded cache evicts torrent files',
		async () => {
			const harness = await PrivateSwarmHarness.start()
			try {
				harness.config.torrent.cacheCapacityBytes = 1
				await harness.register(true)
				const statusUrl = `/api/torrents/${harness.infoHash}/status`
				const initialResponse = await harness.app.request(statusUrl)
				const initial = (await initialResponse.json()) as TorrentStatus
				const completed =
					initial.state === 'completed'
						? initial
						: await waitForTorrentStatus(
								harness,
								statusUrl,
								[],
								initial.progress
							)
				expect(completed.state).toBe('completed')
				await harness.waitForIdleDrop()
				await waitForCacheEviction(harness, harness.infoHash)

				const evictedResponse = await harness.app.request(statusUrl)
				const evicted = (await evictedResponse.json()) as TorrentStatus
				expect(evictedResponse.status).toBe(200)
				expect(evicted.state).toBe('idle')
				expect(evicted.metadataReady).toBe(true)
				expect(evicted.downloadedBytes).toBe(0)
				expect(evicted.totalBytes).toBe(harness.fixture.totalBytes)
				expect(evicted.progress).toBe(0)
				expect(harness.manager.preloadStatus(harness.infoHash)).toBeNull()
				expect(harness.database.getCacheEntry(harness.infoHash)).toBeNull()
			} finally {
				await harness.close()
			}
		},
		INTEGRATION_TIMEOUT_MS
	)

	test(
		'lists metadata-pending registrations immediately, restores them after restart, and cancels them on delete',
		async () => {
			const harness = await PrivateSwarmHarness.start()
			try {
				const pendingInfoHash = 'ffffffffffffffffffffffffffffffffffffffff'
				const statusUrl = `/api/torrents/${pendingInfoHash}/status`
				const unknown = await harness.app.request(statusUrl)
				expect(unknown.status).toBe(404)

				const registrationResponse = await harness.app.request(
					'/api/torrents',
					{
						body: JSON.stringify({
							download: true,
							torrentId: pendingInfoHash,
						}),
						headers: { 'Content-Type': 'application/json' },
						method: 'POST',
					}
				)
				expect(registrationResponse.status).toBe(202)
				expect(await registrationResponse.json()).toEqual({
					backgroundDownload: true,
					infoHash: pendingInfoHash,
					metadataReady: false,
				})

				const pendingResponse = await harness.app.request(statusUrl)
				expect(pendingResponse.status).toBe(200)
				const pending = (await pendingResponse.json()) as TorrentStatus
				expect(pending.state).toBe('fetching_metadata')
				expect(pending.metadataReady).toBe(false)
				expect(pending.name).toBe(`Torrent ${pendingInfoHash}`)
				expect(pending.startedAt).toBeString()

				const listResponse = await harness.app.request('/api/torrents')
				const listed = (await listResponse.json()) as Array<
					TorrentStatus & { firstSeen: string; lastSeen: string }
				>
				const listedPending = listed.find(
					(torrent) => torrent.infoHash === pendingInfoHash
				)
				if (!listedPending) {
					throw new Error('Pending torrent was missing from the torrent list')
				}
				expect(listedPending.state).toBe('fetching_metadata')
				expect(new Date(listedPending.firstSeen).toISOString()).toBe(
					listedPending.firstSeen
				)
				expect(new Date(listedPending.lastSeen).toISOString()).toBe(
					listedPending.lastSeen
				)

				await harness.restartWithoutSeeder()
				const restoredResponse = await harness.app.request(statusUrl)
				const restored = (await restoredResponse.json()) as TorrentStatus
				expect(restoredResponse.status).toBe(200)
				expect(restored.state).toBe('fetching_metadata')
				expect(harness.manager.health().activeSessions).toBe(1)
				expect(harness.manager.health().preloadJobs).toBe(1)

				const firstRemoval = harness.manager.remove(pendingInfoHash)
				const secondRemoval = harness.manager.remove(pendingInfoHash)
				expect(() => harness.manager.register(pendingInfoHash)).toThrow(
					'Torrent removal is already in progress'
				)
				expect(() => harness.manager.startPreload(pendingInfoHash)).toThrow(
					'Torrent removal is already in progress'
				)
				await expect(
					harness.manager.details(pendingInfoHash)
				).rejects.toMatchObject({
					code: 'torrent_removing',
					status: 409,
				})
				expect(await Promise.all([firstRemoval, secondRemoval])).toEqual([
					true,
					true,
				])
				expect((await harness.app.request(statusUrl)).status).toBe(404)
				expect(harness.manager.health().activeSessions).toBe(0)
				expect(harness.manager.health().preloadJobs).toBe(0)
			} finally {
				await harness.close()
			}
		},
		INTEGRATION_TIMEOUT_MS
	)

	test(
		'gracefully closes after WebTorrent has already destroyed its runtime',
		async () => {
			const harness = await PrivateSwarmHarness.start()
			try {
				await new Promise<void>((resolve, reject) => {
					harness.downloader.destroy((error) => {
						if (error) {
							reject(error)
							return
						}
						resolve()
					})
				})
				await expect(harness.manager.close()).resolves.toBeUndefined()
			} finally {
				await harness.close()
			}
		},
		INTEGRATION_TIMEOUT_MS
	)

	test(
		'reports cold and warm TTFB, throughput, RSS, and download amplification with safety budgets',
		async () => {
			const harness = await PrivateSwarmHarness.start()
			try {
				await harness.register()
				const [fixtureFile] = harness.fixture.files
				if (!fixtureFile) {
					throw new Error('Private swarm fixture has no benchmark file')
				}
				const id = requiredFileId(fixtureFile.id, fixtureFile.path)
				const torrent = await harness.torrent()
				expect(torrent.downloaded).toBe(0)

				const rangeStart = 131_089
				const rangeLength = 2 * MIB + 997
				const rangeEnd = rangeStart + rangeLength - 1
				const expected = fixtureFile.bytes.slice(rangeStart, rangeEnd + 1)
				const rangeHeader = `bytes=${rangeStart}-${rangeEnd}`
				const receivedBefore = torrent.received
				const rssBefore = process.memoryUsage().rss
				const coldStartedAt = performance.now()
				const coldResponse = await harness.app.request(fileUrl(harness, id), {
					headers: { Range: rangeHeader },
				})
				const cold = await readResponse(coldResponse, coldStartedAt)
				await delay(50)
				const receivedBytes = torrent.received - receivedBefore
				const rssDeltaBytes = Math.max(0, process.memoryUsage().rss - rssBefore)
				const amplification = receivedBytes / rangeLength

				expect(coldResponse.status).toBe(206)
				expect(cold.body).toEqual(expected)
				expect(cold.firstByteMs).toBeLessThan(5000)
				expect(cold.throughputMiBPerSecond).toBeGreaterThan(0.5)
				expect(amplification).toBeLessThanOrEqual(4)
				expect(rssDeltaBytes).toBeLessThan(256 * MIB)
				reportBenchmark('private-swarm-cold-range', {
					downloadAmplification: Number(amplification.toFixed(3)),
					firstByteMs: Number(cold.firstByteMs.toFixed(2)),
					pieceBytes: torrent.pieceLength,
					requestedBytes: rangeLength,
					rssDeltaMiB: Number((rssDeltaBytes / MIB).toFixed(2)),
					throughputMiBPerSecond: Number(
						cold.throughputMiBPerSecond.toFixed(2)
					),
				})

				const warmReceivedBefore = torrent.received
				const warmStartedAt = performance.now()
				const warmResponse = await harness.app.request(fileUrl(harness, id), {
					headers: { Range: rangeHeader },
				})
				const warm = await readResponse(warmResponse, warmStartedAt)
				await delay(25)
				const warmNetworkBytes = torrent.received - warmReceivedBefore
				expect(warm.body).toEqual(expected)
				expect(warm.firstByteMs).toBeLessThan(2000)
				expect(warm.throughputMiBPerSecond).toBeGreaterThan(1)
				expect(warmNetworkBytes).toBeLessThanOrEqual(torrent.pieceLength)
				reportBenchmark('private-swarm-warm-range', {
					firstByteMs: Number(warm.firstByteMs.toFixed(2)),
					networkBytes: warmNetworkBytes,
					requestedBytes: rangeLength,
					throughputMiBPerSecond: Number(
						warm.throughputMiBPerSecond.toFixed(2)
					),
				})
			} finally {
				await harness.close()
			}
		},
		INTEGRATION_TIMEOUT_MS
	)
})

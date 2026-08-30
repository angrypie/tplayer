import { describe, expect, test } from 'bun:test'
import { reportBenchmark } from '../test/benchmark'
import {
	delay,
	PrivateSwarmHarness,
	readResponse,
	sha256,
} from '../test/harness'
import type { PreloadStatus } from './manager'

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
				const currentShellRegistration = await harness.app.request(
					'/api/torrents',
					{
						body: JSON.stringify({ torrentId: harness.infoHash }),
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
		'preloads once, reports real progress, survives idle eviction, and serves the complete cache after restart without a seed',
		async () => {
			const harness = await PrivateSwarmHarness.start(75)
			try {
				await harness.register()
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

				await harness.stopSeeder()
				await harness.waitForIdleDrop()
				expect(harness.manager.health().activeSessions).toBe(0)
				await harness.restartWithoutSeeder()

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

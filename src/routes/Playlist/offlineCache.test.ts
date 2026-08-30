/// <reference types="bun" />

import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { serve } from 'bun'
import { IDBKeyRange, indexedDB } from 'fake-indexeddb'
import { createStorage } from '~/storage'
import { reportBenchmark } from '../../../server/test/benchmark'
import {
	OFFLINE_CACHE_CHUNK_BYTES,
	OFFLINE_CACHE_PURPOSE,
	OFFLINE_CACHE_PURPOSE_HEADER,
	OfflineCacheError,
	type OfflineCacheFetcher,
	OfflineCacheManager,
	type OfflineCacheProgress,
} from './offlineCache'

const INFO_HASH = '1234567890abcdef1234567890abcdef12345678'
const FILE_PATH = ['Measured audiobook', '01.m4b'] as const
const CLOSED_RANGE_PATTERN = /^bytes=(\d+)-(\d+)$/u
const BENCHMARK_FILE_BYTES = 32 * OFFLINE_CACHE_CHUNK_BYTES
const BENCHMARK_SHA256 =
	'1f3cf1ff01cd7fd1fabd191b68531b362df1b2f46fc8acea96f9c87fddcf85e3'
const BENCHMARK_TIMEOUT_MS = 30_000
const MINIMUM_CACHE_THROUGHPUT_MIB_PER_SECOND = 2
const WIRE_CHUNK_BYTES = 64 * 1024

interface RangeMetric {
	end: number
	purpose: string | null
	start: number
}

interface MeasuredRangeMetric extends RangeMetric {
	bodyBytes: number
}

interface ValidatorRangeMetric extends RangeMetric {
	ifRange: string | null
	responseValidator: string
}

interface RangeServerMetrics {
	activeBodyBytes: number
	activeResponses: number
	maxActiveBodyBytes: number
	maxActiveResponses: number
	maxWireChunkBytes: number
	requests: MeasuredRangeMetric[]
}

const uniqueDatabaseName = (label: string): string =>
	`tplayer-offline-${label}-${crypto.randomUUID()}`

const deterministicBytes = (length: number): Uint8Array<ArrayBuffer> =>
	Uint8Array.from({ length }, (_, index) => (index * 41 + 23) % 251)

const digest = (bytes: Uint8Array): string =>
	createHash('sha256').update(bytes).digest('hex')

const honoFileValidator = (length: number): string =>
	`"${INFO_HASH}-0-${length}"`

const rangeFromHeaders = (headers: HeadersInit | undefined) => {
	const value = new Headers(headers).get('range')
	const match = value?.match(CLOSED_RANGE_PATTERN)
	if (!match) {
		throw new Error(`Expected a closed byte range, received ${String(value)}`)
	}
	return { end: Number(match[2]), start: Number(match[1]) }
}

const createMeasuredBody = (
	bytes: Uint8Array,
	metric: MeasuredRangeMetric,
	serverMetrics: RangeServerMetrics
): ReadableStream<Uint8Array> => {
	let offset = metric.start
	let settled = false
	const responseBytes = metric.end - metric.start + 1
	const settle = (): void => {
		if (settled) {
			return
		}
		settled = true
		serverMetrics.activeBodyBytes -= responseBytes
		serverMetrics.activeResponses -= 1
	}
	return new ReadableStream<Uint8Array>({
		cancel: settle,
		pull: (controller) => {
			if (offset > metric.end) {
				controller.close()
				settle()
				return
			}
			const nextOffset = Math.min(metric.end + 1, offset + WIRE_CHUNK_BYTES)
			const chunk = bytes.slice(offset, nextOffset)
			metric.bodyBytes += chunk.byteLength
			serverMetrics.maxWireChunkBytes = Math.max(
				serverMetrics.maxWireChunkBytes,
				chunk.byteLength
			)
			controller.enqueue(chunk)
			offset = nextOffset
			if (offset > metric.end) {
				controller.close()
				settle()
			}
		},
	})
}

const startMeasuredRangeServer = (bytes: Uint8Array) => {
	const metrics: RangeServerMetrics = {
		activeBodyBytes: 0,
		activeResponses: 0,
		maxActiveBodyBytes: 0,
		maxActiveResponses: 0,
		maxWireChunkBytes: 0,
		requests: [],
	}
	const server = serve({
		fetch: (request) => {
			const range = rangeFromHeaders(request.headers)
			if (
				range.start < 0 ||
				range.end < range.start ||
				range.end >= bytes.byteLength
			) {
				return new Response(null, { status: 416 })
			}
			const responseBytes = range.end - range.start + 1
			const metric: MeasuredRangeMetric = {
				bodyBytes: 0,
				...range,
				purpose: request.headers.get(OFFLINE_CACHE_PURPOSE_HEADER),
			}
			metrics.requests.push(metric)
			metrics.activeResponses += 1
			metrics.activeBodyBytes += responseBytes
			metrics.maxActiveResponses = Math.max(
				metrics.maxActiveResponses,
				metrics.activeResponses
			)
			metrics.maxActiveBodyBytes = Math.max(
				metrics.maxActiveBodyBytes,
				metrics.activeBodyBytes
			)
			return new Response(createMeasuredBody(bytes, metric, metrics), {
				headers: {
					'Content-Length': String(responseBytes),
					'Content-Range': `bytes ${range.start}-${range.end}/${bytes.byteLength}`,
					'Content-Type': 'audio/mp4',
					ETag: honoFileValidator(bytes.byteLength),
				},
				status: 206,
			})
		},
		hostname: '127.0.0.1',
		port: 0,
	})
	return { metrics, server }
}

const createRangeFetcher =
	(
		bytes: Uint8Array,
		metrics: RangeMetric[],
		shouldFail?: (range: { end: number; start: number }) => boolean
	): OfflineCacheFetcher =>
	(_input, init) => {
		const range = rangeFromHeaders(init?.headers)
		if (shouldFail?.(range)) {
			throw new TypeError('Injected range interruption')
		}
		metrics.push({
			...range,
			purpose: new Headers(init?.headers).get(OFFLINE_CACHE_PURPOSE_HEADER),
		})
		const body = bytes.slice(range.start, range.end + 1)
		return Promise.resolve(
			new Response(body, {
				headers: {
					'Content-Range': `bytes ${range.start}-${range.end}/${bytes.byteLength}`,
					'Content-Type': 'audio/mp4',
					ETag: honoFileValidator(bytes.byteLength),
				},
				status: 206,
			})
		)
	}

const createValidatorRangeFetcher =
	(
		bytes: Uint8Array,
		metrics: ValidatorRangeMetric[],
		validatorForRequest: (requestIndex: number) => string
	): OfflineCacheFetcher =>
	(_input, init) => {
		const range = rangeFromHeaders(init?.headers)
		const requestHeaders = new Headers(init?.headers)
		const responseValidator = validatorForRequest(metrics.length)
		metrics.push({
			...range,
			ifRange: requestHeaders.get('if-range'),
			purpose: requestHeaders.get(OFFLINE_CACHE_PURPOSE_HEADER),
			responseValidator,
		})
		return Promise.resolve(
			new Response(bytes.slice(range.start, range.end + 1), {
				headers: {
					'Content-Range': `bytes ${range.start}-${range.end}/${bytes.byteLength}`,
					'Content-Type': 'audio/mp4',
					ETag: responseValidator,
				},
				status: 206,
			})
		)
	}

const openRepository = (databaseName: string) =>
	createStorage({
		databaseName,
		IDBKeyRange,
		indexedDB,
	})

const createRepository = (label: string) =>
	openRepository(uniqueDatabaseName(label))

const cacheFile = {
	length: 0,
	mimeType: 'audio/mp4',
	path: FILE_PATH,
	url: '/api/torrents/hash/files/0',
}

describe('chunked offline cache integration', () => {
	test(
		'caches 32 MiB over measured HTTP ranges with exact bytes and bounded performance',
		async () => {
			const repository = createRepository('performance')
			const bytes = deterministicBytes(BENCHMARK_FILE_BYTES)
			const { metrics, server } = startMeasuredRangeServer(bytes)
			const manager = new OfflineCacheManager(repository, {
				estimateStorage: () =>
					Promise.resolve({
						quota: 512 * OFFLINE_CACHE_CHUNK_BYTES,
						usage: 0,
					}),
				requestPersistentStorage: () => Promise.resolve(true),
			})
			try {
				const startedAt = performance.now()
				const completed = await manager.cacheFile(INFO_HASH, {
					...cacheFile,
					length: bytes.byteLength,
					url: new URL('/audio', server.url).href,
				})
				const durationMs = performance.now() - startedAt
				const throughputMiBPerSecond =
					bytes.byteLength / OFFLINE_CACHE_CHUNK_BYTES / (durationMs / 1000)
				const stored = await repository.getFileBlob(
					INFO_HASH,
					FILE_PATH.join('/')
				)
				const reconstructed = new Uint8Array(
					await (stored ?? new Blob()).arrayBuffer()
				)
				const reconstructedDigest = digest(reconstructed)

				expect(completed).toMatchObject({
					complete: true,
					downloadedBytes: BENCHMARK_FILE_BYTES,
				})
				expect(metrics.requests).toHaveLength(
					BENCHMARK_FILE_BYTES / OFFLINE_CACHE_CHUNK_BYTES
				)
				expect(metrics.requests[0]?.start).toBe(0)
				expect(
					metrics.requests[BENCHMARK_FILE_BYTES / OFFLINE_CACHE_CHUNK_BYTES - 1]
						?.end
				).toBe(BENCHMARK_FILE_BYTES - 1)
				expect(
					metrics.requests.every((request, index) => {
						const previous = metrics.requests[index - 1]
						return (
							request.purpose === OFFLINE_CACHE_PURPOSE &&
							request.end - request.start + 1 <= OFFLINE_CACHE_CHUNK_BYTES &&
							request.bodyBytes === request.end - request.start + 1 &&
							(index === 0 || request.start === (previous?.end ?? -1) + 1)
						)
					})
				).toBe(true)
				expect(
					metrics.requests.reduce(
						(totalBytes, request) => totalBytes + request.bodyBytes,
						0
					)
				).toBe(BENCHMARK_FILE_BYTES)
				expect(metrics.maxActiveResponses).toBe(1)
				expect(metrics.maxActiveBodyBytes).toBeLessThanOrEqual(
					OFFLINE_CACHE_CHUNK_BYTES
				)
				expect(metrics.maxWireChunkBytes).toBeLessThanOrEqual(WIRE_CHUNK_BYTES)
				expect(reconstructed.byteLength).toBe(BENCHMARK_FILE_BYTES)
				expect(reconstructedDigest).toBe(BENCHMARK_SHA256)
				expect(throughputMiBPerSecond).toBeGreaterThan(
					MINIMUM_CACHE_THROUGHPUT_MIB_PER_SECOND
				)
				reportBenchmark('offline-cache-32mib', {
					bytes: BENCHMARK_FILE_BYTES,
					durationMilliseconds: Number(durationMs.toFixed(2)),
					maxActiveResponses: metrics.maxActiveResponses,
					maxInFlightBodyBytes: metrics.maxActiveBodyBytes,
					maxResponseBytes: Math.max(
						...metrics.requests.map(
							(request) => request.end - request.start + 1
						)
					),
					maxWireChunkBytes: metrics.maxWireChunkBytes,
					requests: metrics.requests.length,
					sha256: reconstructedDigest,
					throughputMiBPerSecond: Number(throughputMiBPerSecond.toFixed(2)),
				})
			} finally {
				server.stop(true)
				await repository.deleteDatabase()
			}
		},
		BENCHMARK_TIMEOUT_MS
	)

	test('coalesces 32 callers into exact non-overlapping 1 MiB ranges and reconstructs every byte', async () => {
		const repository = createRepository('dedupe')
		const bytes = deterministicBytes(8 * OFFLINE_CACHE_CHUNK_BYTES + 12_345)
		const metrics: RangeMetric[] = []
		let persistenceRequests = 0
		const manager = new OfflineCacheManager(repository, {
			estimateStorage: () =>
				Promise.resolve({
					quota: 512 * OFFLINE_CACHE_CHUNK_BYTES,
					usage: 0,
				}),
			fetcher: createRangeFetcher(bytes, metrics),
			requestPersistentStorage: () => {
				persistenceRequests += 1
				return Promise.resolve(true)
			},
		})
		const progress: OfflineCacheProgress[] = []
		try {
			await Promise.all(
				Array.from({ length: 32 }, async (_, index) => {
					await manager.cacheFile(
						INFO_HASH,
						{ ...cacheFile, length: bytes.byteLength },
						index === 0 ? (value) => progress.push(value) : undefined
					)
				})
			)

			const expectedRequestCount = Math.ceil(
				bytes.byteLength / OFFLINE_CACHE_CHUNK_BYTES
			)
			expect(metrics).toHaveLength(expectedRequestCount)
			expect(
				new Set(metrics.map(({ start, end }) => `${start}-${end}`)).size
			).toBe(expectedRequestCount)
			expect(metrics[0]?.start).toBe(0)
			expect(metrics[expectedRequestCount - 1]?.end).toBe(bytes.byteLength - 1)
			expect(
				metrics.every(
					({ start, end, purpose }) =>
						end - start + 1 <= OFFLINE_CACHE_CHUNK_BYTES &&
						purpose === OFFLINE_CACHE_PURPOSE
				)
			).toBe(true)
			expect(persistenceRequests).toBe(1)
			expect(
				progress.every(
					(value, index) =>
						index === 0 ||
						value.downloadedBytes >= (progress[index - 1]?.downloadedBytes ?? 0)
				)
			).toBe(true)
			expect(progress.find(({ state }) => state === 'complete')).toEqual({
				downloadedBytes: bytes.byteLength,
				percent: 100,
				state: 'complete',
				totalBytes: bytes.byteLength,
			})

			const stored = await repository.getFileBlob(
				INFO_HASH,
				FILE_PATH.join('/')
			)
			const reconstructed = new Uint8Array(
				await (stored ?? new Blob()).arrayBuffer()
			)
			expect(reconstructed.byteLength).toBe(bytes.byteLength)
			expect(digest(reconstructed)).toBe(digest(bytes))
		} finally {
			await repository.deleteDatabase()
		}
	})

	test('deduplicates two tab managers through the IndexedDB lease fallback and transfers each byte once', async () => {
		const databaseName = uniqueDatabaseName('two-tab-dedupe')
		const firstRepository = openRepository(databaseName)
		const secondRepository = openRepository(databaseName)
		const bytes = deterministicBytes(5 * OFFLINE_CACHE_CHUNK_BYTES + 913)
		const metrics: RangeMetric[] = []
		const options = {
			estimateStorage: () =>
				Promise.resolve({ quota: bytes.byteLength * 8, usage: 0 }),
			fetcher: createRangeFetcher(bytes, metrics),
			requestPersistentStorage: () => Promise.resolve(true),
		}
		const firstManager = new OfflineCacheManager(firstRepository, options)
		const secondManager = new OfflineCacheManager(secondRepository, options)
		try {
			await Promise.all([
				firstManager.cacheFile(INFO_HASH, {
					...cacheFile,
					length: bytes.byteLength,
				}),
				secondManager.cacheFile(INFO_HASH, {
					...cacheFile,
					length: bytes.byteLength,
				}),
			])
			const expectedRequests = Math.ceil(
				bytes.byteLength / OFFLINE_CACHE_CHUNK_BYTES
			)
			expect(metrics).toHaveLength(expectedRequests)
			expect(
				metrics.reduce((total, { end, start }) => total + end - start + 1, 0)
			).toBe(bytes.byteLength)
			const stored = await secondRepository.getFileBlob(
				INFO_HASH,
				FILE_PATH.join('/')
			)
			expect(
				digest(new Uint8Array(await (stored ?? new Blob()).arrayBuffer()))
			).toBe(digest(bytes))
		} finally {
			secondRepository.close()
			await firstRepository.deleteDatabase()
		}
	})

	test('aborts without persisting a chunk when an IndexedDB lease owner is replaced', async () => {
		const databaseName = uniqueDatabaseName('lease-loss')
		const firstRepository = openRepository(databaseName)
		const secondRepository = openRepository(databaseName)
		const bytes = deterministicBytes(OFFLINE_CACHE_CHUNK_BYTES)
		let releaseResponse: () => void = () => {
			throw new Error('The controlled range request did not start')
		}
		let markStarted: () => void = () => undefined
		const started = new Promise<void>((resolve) => {
			markStarted = resolve
		})
		const heldFetcher: OfflineCacheFetcher = (_input, init) => {
			const range = rangeFromHeaders(init?.headers)
			markStarted()
			return new Promise<Response>((resolve) => {
				releaseResponse = () => {
					resolve(
						new Response(bytes.slice(range.start, range.end + 1), {
							headers: {
								'Content-Range': `bytes ${range.start}-${range.end}/${bytes.byteLength}`,
								ETag: honoFileValidator(bytes.byteLength),
							},
							status: 206,
						})
					)
				}
			})
		}
		const firstManager = new OfflineCacheManager(firstRepository, {
			estimateStorage: () =>
				Promise.resolve({ quota: bytes.byteLength * 8, usage: 0 }),
			fetcher: heldFetcher,
			requestPersistentStorage: () => Promise.resolve(true),
		})
		const storedPath = FILE_PATH.join('/')
		const leaseName = `tplayer:offline-file:${INFO_HASH}:${JSON.stringify(storedPath)}`
		try {
			const caching = firstManager.cacheFile(INFO_HASH, {
				...cacheFile,
				length: bytes.byteLength,
			})
			await started
			const takeoverTime = Date.now() + 120_000
			expect(
				await secondRepository.tryAcquireOfflineLease(
					leaseName,
					'second-owner',
					takeoverTime,
					takeoverTime + 60_000
				)
			).toBe(true)
			releaseResponse()
			await expect(caching).rejects.toMatchObject({ name: 'AbortError' })
			expect(
				await firstRepository.getStoredFileChunkIndexes(INFO_HASH, storedPath)
			).toEqual(new Set())
			expect(
				await firstRepository.getOfflineFileState(INFO_HASH, storedPath)
			).toMatchObject({ complete: false, downloadedBytes: 0 })
		} finally {
			await secondRepository.releaseOfflineLease(leaseName, 'second-owner')
			secondRepository.close()
			await firstRepository.deleteDatabase()
		}
	})

	test('a clear in another tab rejects an in-flight late chunk without resurrecting data', async () => {
		const databaseName = uniqueDatabaseName('two-tab-clear')
		const firstRepository = openRepository(databaseName)
		const secondRepository = openRepository(databaseName)
		const bytes = deterministicBytes(2 * OFFLINE_CACHE_CHUNK_BYTES)
		const responseGate: { release: () => void } = {
			release: () => {
				throw new Error('Range response was not started')
			},
		}
		let markStarted: (() => void) | null = null
		const started = new Promise<void>((resolve) => {
			markStarted = resolve
		})
		const fetcher: OfflineCacheFetcher = (_input, init) => {
			const range = rangeFromHeaders(init?.headers)
			markStarted?.()
			return new Promise<Response>((resolve) => {
				responseGate.release = () => {
					resolve(
						new Response(bytes.slice(range.start, range.end + 1), {
							headers: {
								'Content-Range': `bytes ${range.start}-${range.end}/${bytes.byteLength}`,
								ETag: honoFileValidator(bytes.byteLength),
							},
							status: 206,
						})
					)
				}
			})
		}
		const manager = new OfflineCacheManager(firstRepository, {
			estimateStorage: () =>
				Promise.resolve({ quota: bytes.byteLength * 8, usage: 0 }),
			fetcher,
			requestPersistentStorage: () => Promise.resolve(true),
		})
		try {
			const caching = manager.cacheFile(INFO_HASH, {
				...cacheFile,
				length: bytes.byteLength,
			})
			await started
			expect(await secondRepository.removeFilesByIh(INFO_HASH)).toBe(true)
			responseGate.release()
			await expect(caching).rejects.toMatchObject({ name: 'AbortError' })
			expect(
				await firstRepository.getOfflineFileState(
					INFO_HASH,
					FILE_PATH.join('/')
				)
			).toBeNull()
			expect(
				await firstRepository.getStoredFileChunkIndexes(
					INFO_HASH,
					FILE_PATH.join('/')
				)
			).toEqual(new Set())
		} finally {
			secondRepository.close()
			await firstRepository.deleteDatabase()
		}
	})

	test('one bulk generation prevents later files from restarting after a cross-tab clear', async () => {
		const databaseName = uniqueDatabaseName('bulk-generation')
		const firstRepository = openRepository(databaseName)
		const secondRepository = openRepository(databaseName)
		const bytes = deterministicBytes(OFFLINE_CACHE_CHUNK_BYTES)
		const metrics: RangeMetric[] = []
		const manager = new OfflineCacheManager(firstRepository, {
			estimateStorage: () =>
				Promise.resolve({ quota: bytes.byteLength * 8, usage: 0 }),
			fetcher: createRangeFetcher(bytes, metrics),
			requestPersistentStorage: () => Promise.resolve(true),
		})
		try {
			const bulkGeneration =
				await firstRepository.getOfflineGeneration(INFO_HASH)
			expect(await secondRepository.removeFilesByIh(INFO_HASH)).toBe(true)
			await expect(
				manager.cacheFile(
					INFO_HASH,
					{
						...cacheFile,
						length: bytes.byteLength,
						path: ['Measured audiobook', '02.m4b'],
					},
					undefined,
					{ expectedGeneration: bulkGeneration }
				)
			).rejects.toMatchObject({ name: 'AbortError' })
			expect(metrics).toEqual([])
			expect(
				await firstRepository.getOfflineFileStatesForTorrent(INFO_HASH)
			).toEqual([])
		} finally {
			secondRepository.close()
			await firstRepository.deleteDatabase()
		}
	})

	test('cancels a full response body when an intermediary ignores the Range request', async () => {
		const repository = createRepository('ignored-range')
		let bodyCancellations = 0
		const responseBody = new ReadableStream<Uint8Array>({
			cancel: () => {
				bodyCancellations += 1
			},
			start: (controller) => {
				controller.enqueue(deterministicBytes(64 * 1024))
			},
		})
		const manager = new OfflineCacheManager(repository, {
			estimateStorage: () =>
				Promise.resolve({ quota: 8 * OFFLINE_CACHE_CHUNK_BYTES, usage: 0 }),
			fetcher: () =>
				Promise.resolve(
					new Response(responseBody, {
						headers: { 'Content-Type': 'audio/mp4' },
						status: 200,
					})
				),
			requestPersistentStorage: () => Promise.resolve(true),
		})
		try {
			await expect(
				manager.cacheFile(INFO_HASH, {
					...cacheFile,
					length: 4 * OFFLINE_CACHE_CHUNK_BYTES,
				})
			).rejects.toMatchObject({ code: 'request_failed', status: 200 })
			expect(bodyCancellations).toBe(1)
			expect(
				await repository.getOfflineFileState(INFO_HASH, FILE_PATH.join('/'))
			).toMatchObject({ complete: false, downloadedBytes: 0 })
		} finally {
			await repository.deleteDatabase()
		}
	})

	test('pins Hono strong ETag validation across every chunk request', async () => {
		const repository = createRepository('stable-validator')
		const bytes = deterministicBytes(3 * OFFLINE_CACHE_CHUNK_BYTES + 211)
		const validator = honoFileValidator(bytes.byteLength)
		const metrics: ValidatorRangeMetric[] = []
		const manager = new OfflineCacheManager(repository, {
			estimateStorage: () =>
				Promise.resolve({ quota: bytes.byteLength * 4, usage: 0 }),
			fetcher: createValidatorRangeFetcher(bytes, metrics, () => validator),
			requestPersistentStorage: () => Promise.resolve(true),
		})
		try {
			await manager.cacheFile(INFO_HASH, {
				...cacheFile,
				length: bytes.byteLength,
			})
			expect(metrics).toHaveLength(4)
			expect(metrics[0]?.ifRange).toBeNull()
			expect(
				metrics.slice(1).every(({ ifRange }) => ifRange === validator)
			).toBe(true)
			expect(
				metrics.every(
					({ purpose, responseValidator }) =>
						purpose === OFFLINE_CACHE_PURPOSE && responseValidator === validator
				)
			).toBe(true)
		} finally {
			await repository.deleteDatabase()
		}
	})

	test('rejects a changed Hono ETag before mixed-representation bytes are persisted', async () => {
		const repository = createRepository('changed-validator')
		const bytes = deterministicBytes(2 * OFFLINE_CACHE_CHUNK_BYTES)
		const validator = honoFileValidator(bytes.byteLength)
		const replacementValidator = `"${INFO_HASH}-replacement-${bytes.byteLength}"`
		const metrics: ValidatorRangeMetric[] = []
		const manager = new OfflineCacheManager(repository, {
			estimateStorage: () =>
				Promise.resolve({ quota: bytes.byteLength * 4, usage: 0 }),
			fetcher: createValidatorRangeFetcher(bytes, metrics, (requestIndex) =>
				requestIndex === 0 ? validator : replacementValidator
			),
			requestPersistentStorage: () => Promise.resolve(true),
		})
		try {
			await expect(
				manager.cacheFile(INFO_HASH, {
					...cacheFile,
					length: bytes.byteLength,
				})
			).rejects.toMatchObject({ code: 'invalid_range' })
			expect(metrics).toHaveLength(2)
			expect(metrics[1]?.ifRange).toBe(validator)
			expect(
				await repository.getOfflineFileState(INFO_HASH, FILE_PATH.join('/'))
			).toMatchObject({
				complete: false,
				downloadedBytes: OFFLINE_CACHE_CHUNK_BYTES,
			})
			expect(
				await repository.getStoredFileChunkIndexes(
					INFO_HASH,
					FILE_PATH.join('/')
				)
			).toEqual(new Set([0]))
		} finally {
			await repository.deleteDatabase()
		}
	})

	test('resumes at the first missing byte after a three-chunk interruption', async () => {
		const repository = createRepository('resume')
		const bytes = deterministicBytes(6 * OFFLINE_CACHE_CHUNK_BYTES + 777)
		const firstMetrics: RangeMetric[] = []
		const firstManager = new OfflineCacheManager(repository, {
			estimateStorage: () =>
				Promise.resolve({ quota: bytes.byteLength * 4, usage: 0 }),
			fetcher: createRangeFetcher(
				bytes,
				firstMetrics,
				({ start }) => start >= 3 * OFFLINE_CACHE_CHUNK_BYTES
			),
			requestPersistentStorage: () => Promise.resolve(true),
		})
		try {
			await expect(
				firstManager.cacheFile(INFO_HASH, {
					...cacheFile,
					length: bytes.byteLength,
				})
			).rejects.toMatchObject({ code: 'request_failed' })
			const partial = await repository.getOfflineFileState(
				INFO_HASH,
				FILE_PATH.join('/')
			)
			expect(partial?.downloadedBytes).toBe(3 * OFFLINE_CACHE_CHUNK_BYTES)

			const resumedMetrics: RangeMetric[] = []
			const resumedManager = new OfflineCacheManager(repository, {
				estimateStorage: () =>
					Promise.resolve({
						quota: bytes.byteLength * 4,
						usage: 0,
					}),
				fetcher: createRangeFetcher(bytes, resumedMetrics),
				requestPersistentStorage: () => Promise.resolve(true),
			})
			await resumedManager.cacheFile(INFO_HASH, {
				...cacheFile,
				length: bytes.byteLength,
			})
			expect(resumedMetrics[0]?.start).toBe(3 * OFFLINE_CACHE_CHUNK_BYTES)
			const resumedRequestCount =
				Math.ceil(bytes.byteLength / OFFLINE_CACHE_CHUNK_BYTES) - 3
			expect(resumedMetrics[resumedRequestCount - 1]?.end).toBe(
				bytes.byteLength - 1
			)
			expect(
				resumedMetrics.some(
					({ start }) => start < 3 * OFFLINE_CACHE_CHUNK_BYTES
				)
			).toBe(false)

			const stored = await repository.getFileBlob(
				INFO_HASH,
				FILE_PATH.join('/')
			)
			expect(
				digest(new Uint8Array(await (stored ?? new Blob()).arrayBuffer()))
			).toBe(digest(bytes))
		} finally {
			await repository.deleteDatabase()
		}
	})

	test('refuses an oversized save before network transfer while preserving streaming data', async () => {
		const repository = createRepository('quota')
		const bytes = deterministicBytes(8 * OFFLINE_CACHE_CHUNK_BYTES)
		const metrics: RangeMetric[] = []
		const manager = new OfflineCacheManager(repository, {
			estimateStorage: () =>
				Promise.resolve({
					quota: 10 * OFFLINE_CACHE_CHUNK_BYTES,
					usage: 9 * OFFLINE_CACHE_CHUNK_BYTES,
				}),
			fetcher: createRangeFetcher(bytes, metrics),
			requestPersistentStorage: () => Promise.resolve(false),
		})
		try {
			await expect(
				manager.cacheFile(INFO_HASH, {
					...cacheFile,
					length: bytes.byteLength,
				})
			).rejects.toBeInstanceOf(OfflineCacheError)
			expect(metrics).toEqual([])
			expect(
				await repository.getOfflineFileState(INFO_HASH, FILE_PATH.join('/'))
			).toMatchObject({ complete: false, downloadedBytes: 0 })
		} finally {
			await repository.deleteDatabase()
		}
	})

	test('maps a Dexie-style named Error to a quota-specific offline failure', async () => {
		const repository = createRepository('dexie-quota-error')
		const bytes = deterministicBytes(OFFLINE_CACHE_CHUNK_BYTES)
		const quotaFailure = new Error('Injected Dexie bulkPut quota failure')
		quotaFailure.name = 'QuotaExceededError'
		repository.putFileChunk = () => Promise.reject(quotaFailure)
		const manager = new OfflineCacheManager(repository, {
			estimateStorage: () =>
				Promise.resolve({ quota: bytes.byteLength * 4, usage: 0 }),
			fetcher: createRangeFetcher(bytes, []),
			requestPersistentStorage: () => Promise.resolve(true),
		})
		try {
			await expect(
				manager.cacheFile(INFO_HASH, {
					...cacheFile,
					length: bytes.byteLength,
				})
			).rejects.toMatchObject({
				cause: quotaFailure,
				code: 'quota_exceeded',
				name: 'OfflineCacheError',
			})
			expect(
				await repository.getOfflineFileState(INFO_HASH, FILE_PATH.join('/'))
			).toMatchObject({ complete: false, downloadedBytes: 0 })
		} finally {
			await repository.deleteDatabase()
		}
	})

	test('cancellation settles before cleanup so a late response cannot recreate bytes', async () => {
		const repository = createRepository('cancel-clean')
		const bytes = deterministicBytes(2 * OFFLINE_CACHE_CHUNK_BYTES)
		let requestStarted: (() => void) | null = null
		const started = new Promise<void>((resolve) => {
			requestStarted = resolve
		})
		const fetcher: OfflineCacheFetcher = (_input, init) => {
			requestStarted?.()
			return new Promise<Response>((_resolve, reject) => {
				const rejectAbort = () =>
					reject(new DOMException('Injected cancellation', 'AbortError'))
				if (init?.signal?.aborted) {
					rejectAbort()
					return
				}
				init?.signal?.addEventListener('abort', rejectAbort, { once: true })
			})
		}
		const manager = new OfflineCacheManager(repository, {
			estimateStorage: () =>
				Promise.resolve({ quota: bytes.byteLength * 4, usage: 0 }),
			fetcher,
			requestPersistentStorage: () => Promise.resolve(true),
		})
		try {
			const caching = manager.cacheFile(INFO_HASH, {
				...cacheFile,
				length: bytes.byteLength,
			})
			await started
			await manager.cancel(INFO_HASH, FILE_PATH)
			await expect(caching).rejects.toMatchObject({ name: 'AbortError' })
			expect(await repository.removeFile(INFO_HASH, FILE_PATH.join('/'))).toBe(
				true
			)
			await new Promise((resolve) => setTimeout(resolve, 25))
			expect(
				await repository.getOfflineFileState(INFO_HASH, FILE_PATH.join('/'))
			).toBeNull()
			expect(
				await repository.getStoredFileChunkIndexes(
					INFO_HASH,
					FILE_PATH.join('/')
				)
			).toEqual(new Set())
		} finally {
			await repository.deleteDatabase()
		}
	})
})

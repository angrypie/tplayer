import type { BookStorage, OfflineFileState } from '~/storage'
import { publishOfflineChange } from './offlineEvents'

const CONTENT_RANGE_PATTERN = /^bytes (\d+)-(\d+)\/(\d+)$/u
const MEBIBYTE = 1024 * 1024
const STORAGE_RESERVE_RATIO = 0.05
const MAXIMUM_STORAGE_RESERVE_BYTES = 16 * MEBIBYTE
const OFFLINE_LEASE_DURATION_MS = 60_000
const OFFLINE_LEASE_POLL_MS = 100
const OFFLINE_LEASE_RENEW_MS = 10_000
const STALE_PARTIAL_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

export const OFFLINE_CACHE_CHUNK_BYTES = MEBIBYTE
export const OFFLINE_CACHE_PURPOSE = 'offline-cache'
export const OFFLINE_CACHE_PURPOSE_HEADER = 'X-TPlayer-Purpose'

export type OfflineCacheProgressState = 'checking' | 'complete' | 'downloading'

export interface OfflineCacheProgress {
	downloadedBytes: number
	percent: number
	state: OfflineCacheProgressState
	totalBytes: number
}

export interface OfflineCacheFile {
	length: number
	mimeType?: string
	path: readonly string[]
	url: string
}

export interface OfflineCacheOptions {
	chunkSizeBytes?: number
	estimateStorage?: () => Promise<StorageEstimate>
	fetcher?: OfflineCacheFetcher
	requestPersistentStorage?: () => Promise<boolean>
}

export interface OfflineCacheRequestOptions {
	expectedGeneration?: number
}

export type OfflineCacheFetcher = (
	...arguments_: Parameters<typeof fetch>
) => ReturnType<typeof fetch>

export type OfflineCacheProgressListener = (
	progress: OfflineCacheProgress
) => void

export type OfflineCacheErrorCode =
	| 'invalid_range'
	| 'quota_exceeded'
	| 'request_failed'

export class OfflineCacheError extends Error {
	readonly availableBytes?: number
	readonly code: OfflineCacheErrorCode
	readonly requiredBytes?: number
	readonly status?: number

	constructor(
		code: OfflineCacheErrorCode,
		message: string,
		details: {
			availableBytes?: number
			cause?: unknown
			requiredBytes?: number
			status?: number
		} = {}
	) {
		super(message, { cause: details.cause })
		this.name = 'OfflineCacheError'
		this.code = code
		this.availableBytes = details.availableBytes
		this.requiredBytes = details.requiredBytes
		this.status = details.status
	}
}

interface ActiveDownload {
	assertExclusiveOwnership?: () => Promise<void>
	controller: AbortController
	current: OfflineCacheProgress
	generation: number
	infoHash: string
	listeners: Set<OfflineCacheProgressListener>
	path: string
	promise: Promise<OfflineFileState>
}

interface DownloadedChunk {
	data: Blob
	validator: string
}

const noStorageEstimate = async (): Promise<StorageEstimate> => ({})

const browserStorageEstimate = async (): Promise<StorageEstimate> => {
	if (typeof navigator === 'undefined' || !navigator.storage?.estimate) {
		return await noStorageEstimate()
	}
	return await navigator.storage.estimate()
}

const requestBrowserPersistence = async (): Promise<boolean> => {
	if (typeof navigator === 'undefined' || !navigator.storage?.persist) {
		return false
	}
	return await navigator.storage.persist()
}

const cancelledDownloadError = (): DOMException =>
	new DOMException('Offline cache download was cancelled', 'AbortError')

const waitForOfflineLease = async (signal: AbortSignal): Promise<void> => {
	if (signal.aborted) {
		throw cancelledDownloadError()
	}
	await new Promise<void>((resolve, reject) => {
		const timeout = setTimeout(() => {
			signal.removeEventListener('abort', handleAbort)
			resolve()
		}, OFFLINE_LEASE_POLL_MS)
		const handleAbort = (): void => {
			clearTimeout(timeout)
			reject(cancelledDownloadError())
		}
		signal.addEventListener('abort', handleAbort, { once: true })
	})
}

const normalizeInfoHash = (infoHash: string): string =>
	infoHash.trim().toLowerCase()

const pathKey = (path: readonly string[]): string => path.join('/')

const downloadKey = (infoHash: string, path: string): string =>
	`${infoHash}\0${path}`

const lockKey = (infoHash: string, path: string): string =>
	`tplayer:offline-file:${infoHash}:${JSON.stringify(path)}`

const progressPercent = (
	downloadedBytes: number,
	totalBytes: number
): number =>
	totalBytes === 0
		? 100
		: Math.min(100, Math.floor((downloadedBytes / totalBytes) * 100))

const progressFromState = (
	state: OfflineFileState,
	progressState: OfflineCacheProgressState
): OfflineCacheProgress => ({
	downloadedBytes: state.downloadedBytes,
	percent: progressPercent(state.downloadedBytes, state.length),
	state: progressState,
	totalBytes: state.length,
})

const isAbortError = (error: unknown): boolean =>
	error instanceof DOMException && error.name === 'AbortError'

const isQuotaError = (error: unknown): boolean =>
	(error instanceof DOMException || error instanceof Error) &&
	error.name === 'QuotaExceededError'

const validateFile = (file: OfflineCacheFile): void => {
	if (!(Number.isSafeInteger(file.length) && file.length >= 0)) {
		throw new Error('Offline file length must be a non-negative safe integer')
	}
	if (file.path.length === 0) {
		throw new Error('Offline file path is required')
	}
}

const parseContentRange = (
	value: string | null
): { end: number; start: number; total: number } | null => {
	const match = value?.match(CONTENT_RANGE_PATTERN)
	if (!match) {
		return null
	}
	return {
		end: Number(match[2]),
		start: Number(match[1]),
		total: Number(match[3]),
	}
}

const storageReserve = (quota: number): number =>
	Math.min(
		MAXIMUM_STORAGE_RESERVE_BYTES,
		Math.floor(quota * STORAGE_RESERVE_RATIO)
	)

export class OfflineCacheManager {
	private readonly activeDownloads = new Map<string, ActiveDownload>()
	private readonly chunkSizeBytes: number
	private chunkTail: Promise<void> = Promise.resolve()
	private cleanupRequest: Promise<void> | null = null
	private readonly estimateStorage: () => Promise<StorageEstimate>
	private readonly fetcher: OfflineCacheFetcher
	private persistenceRequest: Promise<boolean> | true | null = null
	private readonly repository: BookStorage
	private readonly requestPersistentStorage: () => Promise<boolean>

	constructor(repository: BookStorage, options: OfflineCacheOptions = {}) {
		this.repository = repository
		this.chunkSizeBytes = options.chunkSizeBytes ?? OFFLINE_CACHE_CHUNK_BYTES
		if (
			!(Number.isSafeInteger(this.chunkSizeBytes) && this.chunkSizeBytes > 0)
		) {
			throw new Error(
				'Offline cache chunk size must be a positive safe integer'
			)
		}
		this.estimateStorage = options.estimateStorage ?? browserStorageEstimate
		this.fetcher =
			options.fetcher ?? ((input, init) => globalThis.fetch(input, init))
		this.requestPersistentStorage =
			options.requestPersistentStorage ?? requestBrowserPersistence
	}

	async cacheFile(
		infoHash: string,
		file: OfflineCacheFile,
		onProgress?: OfflineCacheProgressListener,
		options: OfflineCacheRequestOptions = {}
	): Promise<OfflineFileState> {
		validateFile(file)
		const normalizedHash = normalizeInfoHash(infoHash)
		const storedPath = pathKey(file.path)
		const key = downloadKey(normalizedHash, storedPath)
		const generation =
			options.expectedGeneration ??
			(await this.repository.getOfflineGeneration(normalizedHash))
		let active = this.activeDownloads.get(key)
		if (active && active.generation !== generation) {
			throw new DOMException(
				'Offline cache generation was invalidated',
				'AbortError'
			)
		}
		if (!active) {
			active = this.startDownload(normalizedHash, storedPath, file, generation)
			this.activeDownloads.set(key, active)
		}
		return await this.subscribe(active, onProgress)
	}

	async cancel(infoHash: string, path?: readonly string[]): Promise<void> {
		const normalizedHash = normalizeInfoHash(infoHash)
		const storedPath = path ? pathKey(path) : null
		const matches = [...this.activeDownloads.values()].filter(
			(active) =>
				active.infoHash === normalizedHash &&
				(storedPath === null || active.path === storedPath)
		)
		for (const active of matches) {
			active.controller.abort()
		}
		await Promise.allSettled(matches.map((active) => active.promise))
	}

	private startDownload(
		infoHash: string,
		storedPath: string,
		file: OfflineCacheFile,
		generation: number
	): ActiveDownload {
		const controller = new AbortController()
		const active: ActiveDownload = {
			controller,
			current: {
				downloadedBytes: 0,
				percent: 0,
				state: 'checking',
				totalBytes: file.length,
			},
			generation,
			infoHash,
			listeners: new Set(),
			path: storedPath,
			promise: Promise.resolve({
				complete: false,
				downloadedBytes: 0,
				generation: 0,
				length: file.length,
				mimeType: file.mimeType ?? '',
				path: storedPath,
			}),
		}
		const key = downloadKey(infoHash, storedPath)
		active.promise = this.runWithCrossTabLock(
			lockKey(infoHash, storedPath),
			active,
			async () => await this.download(active, file, generation)
		).finally(() => {
			if (this.activeDownloads.get(key) === active) {
				this.activeDownloads.delete(key)
			}
		})
		return active
	}

	private async subscribe(
		active: ActiveDownload,
		onProgress?: OfflineCacheProgressListener
	): Promise<OfflineFileState> {
		if (onProgress) {
			active.listeners.add(onProgress)
			onProgress(active.current)
		}
		try {
			return await active.promise
		} finally {
			if (onProgress) {
				active.listeners.delete(onProgress)
			}
		}
	}

	private notify(active: ActiveDownload, progress: OfflineCacheProgress): void {
		active.current = progress
		for (const listener of active.listeners) {
			try {
				listener(progress)
			} catch {
				// A view callback must not interrupt the shared cache operation.
			}
		}
	}

	private async download(
		active: ActiveDownload,
		file: OfflineCacheFile,
		generation: number
	): Promise<OfflineFileState> {
		try {
			return await this.downloadFile(active, file, generation)
		} catch (error) {
			if (isQuotaError(error)) {
				// biome-ignore lint/style/useErrorCause: OfflineCacheError forwards details.cause to Error.
				throw new OfflineCacheError(
					'quota_exceeded',
					'This device ran out of storage while saving the audiobook offline.',
					{ cause: error }
				)
			}
			throw error
		}
	}

	private async downloadFile(
		active: ActiveDownload,
		file: OfflineCacheFile,
		generation: number
	): Promise<OfflineFileState> {
		this.throwIfCancelled(active)
		await this.cleanupStalePartialsOnce()
		await this.requestPersistenceOnce()
		this.throwIfCancelled(active)
		let state = await this.repository.prepareFileDownload(
			active.infoHash,
			active.path,
			file.length,
			file.mimeType ?? '',
			this.chunkSizeBytes,
			generation
		)
		if (state.complete) {
			this.notify(active, progressFromState(state, 'complete'))
			return state
		}
		this.notify(active, progressFromState(state, 'checking'))
		await this.ensureStorageCapacity(file.length - state.downloadedBytes)
		if (state.downloadedBytes > 0 && !state.validator) {
			state = await this.repository.restartFileDownload(
				active.infoHash,
				active.path,
				file.length,
				file.mimeType ?? '',
				this.chunkSizeBytes,
				generation
			)
			this.notify(active, progressFromState(state, 'checking'))
		}

		const storedIndexes = await this.repository.getStoredFileChunkIndexes(
			active.infoHash,
			active.path
		)
		const chunkCount = Math.ceil(file.length / this.chunkSizeBytes)
		for (let index = 0; index < chunkCount; index += 1) {
			if (storedIndexes.has(index)) {
				continue
			}
			this.throwIfCancelled(active)
			const start = index * this.chunkSizeBytes
			const end = Math.min(file.length - 1, start + this.chunkSizeBytes - 1)
			// biome-ignore lint/performance/noAwaitInLoops: One range at a time bounds browser memory and protects playback bandwidth.
			const chunk = await this.scheduleChunk(async () => {
				await active.assertExclusiveOwnership?.()
				const downloadedChunk = await this.fetchChunk(
					file.url,
					start,
					end,
					file.length,
					state.validator,
					active
				)
				await active.assertExclusiveOwnership?.()
				return downloadedChunk
			})
			state = await this.repository.putFileChunk({
				chunkSize: this.chunkSizeBytes,
				data: chunk.data,
				end,
				generation,
				ih: active.infoHash,
				index,
				length: file.length,
				mimeType: chunk.data.type || file.mimeType || '',
				path: active.path,
				start,
				validator: chunk.validator,
			})
			this.notify(active, progressFromState(state, 'downloading'))
		}

		state = await this.repository.completeFileDownload(
			active.infoHash,
			active.path,
			generation
		)
		publishOfflineChange({
			infoHash: active.infoHash,
			kind: 'updated',
			path: active.path,
		})
		this.notify(active, progressFromState(state, 'complete'))
		return state
	}

	private async fetchChunk(
		url: string,
		start: number,
		end: number,
		total: number,
		expectedValidator: string | undefined,
		active: ActiveDownload
	): Promise<DownloadedChunk> {
		let response: Response
		const headers = new Headers({
			Range: `bytes=${start}-${end}`,
			[OFFLINE_CACHE_PURPOSE_HEADER]: OFFLINE_CACHE_PURPOSE,
		})
		if (expectedValidator) {
			headers.set('If-Range', expectedValidator)
		}
		try {
			response = await this.fetcher(url, {
				cache: 'no-store',
				credentials: 'same-origin',
				headers,
				signal: active.controller.signal,
			})
		} catch (error) {
			if (isAbortError(error)) {
				throw error
			}
			// biome-ignore lint/style/useErrorCause: OfflineCacheError forwards details.cause to Error.
			throw new OfflineCacheError(
				'request_failed',
				'Unable to save this audiobook for offline playback.',
				{ cause: error }
			)
		}
		if (response.status !== 206) {
			await response.body?.cancel()
			throw new OfflineCacheError(
				'request_failed',
				`Offline byte range returned HTTP ${response.status}.`,
				{ status: response.status }
			)
		}
		const validator = response.headers.get('etag')?.trim()
		if (
			!validator ||
			validator.startsWith('W/') ||
			(expectedValidator !== undefined && validator !== expectedValidator)
		) {
			await response.body?.cancel()
			throw new OfflineCacheError(
				'invalid_range',
				'Server changed the file while it was being saved offline.'
			)
		}
		const contentRange = parseContentRange(
			response.headers.get('content-range')
		)
		if (
			!contentRange ||
			contentRange.start !== start ||
			contentRange.end !== end ||
			contentRange.total !== total
		) {
			await response.body?.cancel()
			throw new OfflineCacheError(
				'invalid_range',
				'Server returned an invalid byte range for offline storage.'
			)
		}
		const data = await response.blob()
		if (data.size !== end - start + 1) {
			throw new OfflineCacheError(
				'invalid_range',
				'Offline byte range ended before all bytes arrived.'
			)
		}
		return { data, validator }
	}

	private async ensureStorageCapacity(requiredBytes: number): Promise<void> {
		let estimate: StorageEstimate
		try {
			estimate = await this.estimateStorage()
		} catch {
			return
		}
		const { quota, usage } = estimate
		if (
			typeof quota !== 'number' ||
			typeof usage !== 'number' ||
			!Number.isFinite(quota) ||
			!Number.isFinite(usage)
		) {
			return
		}
		const availableBytes = Math.max(0, quota - usage - storageReserve(quota))
		if (requiredBytes <= availableBytes) {
			return
		}
		throw new OfflineCacheError(
			'quota_exceeded',
			'Not enough device storage is available to save this audiobook offline.',
			{ availableBytes, requiredBytes }
		)
	}

	private async cleanupStalePartialsOnce(): Promise<void> {
		if (!this.cleanupRequest) {
			this.cleanupRequest = this.repository
				.cleanupStalePartialDownloads({
					cutoffUpdatedAt: Date.now() - STALE_PARTIAL_MAX_AGE_MS,
				})
				.then(() => undefined)
				.catch(() => undefined)
		}
		await this.cleanupRequest
	}

	private async requestPersistenceOnce(): Promise<void> {
		if (this.persistenceRequest === true) {
			return
		}
		const request = this.persistenceRequest ?? this.requestPersistence()
		this.persistenceRequest = request
		const granted = await request
		if (granted) {
			this.persistenceRequest = true
		} else if (this.persistenceRequest === request) {
			this.persistenceRequest = null
		}
	}

	private async requestPersistence(): Promise<boolean> {
		try {
			return await this.requestPersistentStorage()
		} catch {
			// Persistence is an optimization; quota checks still protect the device.
			return false
		}
	}

	private async runWithCrossTabLock<Value>(
		name: string,
		active: ActiveDownload,
		operation: () => Promise<Value>
	): Promise<Value> {
		const { controller } = active
		const { signal } = controller
		if (typeof navigator !== 'undefined' && navigator.locks?.request) {
			return await navigator.locks.request(
				name,
				{ mode: 'exclusive', signal },
				operation
			)
		}

		const owner = crypto.randomUUID()
		let acquired = false
		while (!acquired) {
			if (signal.aborted) {
				throw cancelledDownloadError()
			}
			const now = Date.now()
			// biome-ignore lint/performance/noAwaitInLoops: Each retry depends on the previous cross-tab lease attempt.
			acquired = await this.repository.tryAcquireOfflineLease(
				name,
				owner,
				now,
				now + OFFLINE_LEASE_DURATION_MS
			)
			if (!acquired) {
				await waitForOfflineLease(signal)
			}
		}

		let rejectLeaseLoss: (error: DOMException) => void = () => undefined
		const leaseLoss = new Promise<never>((_resolve, reject) => {
			rejectLeaseLoss = reject
		})
		let leaseLost = false
		let stopped = false
		const loseLease = (): void => {
			if (leaseLost || stopped) {
				return
			}
			leaseLost = true
			controller.abort()
			rejectLeaseLoss(cancelledDownloadError())
		}
		const renewLease = async (): Promise<void> => {
			if (stopped) {
				return
			}
			try {
				const renewed = await this.repository.renewOfflineLease(
					name,
					owner,
					Date.now() + OFFLINE_LEASE_DURATION_MS
				)
				if (!renewed) {
					loseLease()
				}
			} catch {
				loseLease()
			}
		}
		active.assertExclusiveOwnership = async () => {
			await renewLease()
			if (leaseLost) {
				throw cancelledDownloadError()
			}
		}
		let renewal = Promise.resolve()
		const renewalTimer = setInterval(() => {
			renewal = renewal.then(renewLease, renewLease)
		}, OFFLINE_LEASE_RENEW_MS)
		const operationPromise = operation()
		try {
			return await Promise.race([operationPromise, leaseLoss])
		} finally {
			stopped = true
			clearInterval(renewalTimer)
			active.assertExclusiveOwnership = undefined
			await renewal.catch(() => undefined)
			await operationPromise.catch(() => undefined)
			await this.repository.releaseOfflineLease(name, owner)
		}
	}

	private async scheduleChunk<Value>(
		operation: () => Promise<Value>
	): Promise<Value> {
		const previous = this.chunkTail
		let release: () => void = () => undefined
		this.chunkTail = new Promise<void>((resolve) => {
			release = resolve
		})
		await previous
		try {
			return await operation()
		} finally {
			release()
		}
	}

	private throwIfCancelled(active: ActiveDownload): void {
		if (active.controller.signal.aborted) {
			throw cancelledDownloadError()
		}
	}
}

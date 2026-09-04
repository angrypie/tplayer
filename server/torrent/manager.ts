import type { Dirent } from 'node:fs'
import { readdir, realpath, rm, stat } from 'node:fs/promises'
import {
	isAbsolute,
	join,
	relative,
	resolve as resolvePath,
	sep,
} from 'node:path'
import { file as openBunFile } from 'bun'
import parseTorrent from 'parse-torrent'
import WebTorrent, {
	type Torrent,
	type TorrentFile,
	type TorrentOptions,
} from 'webtorrent'
import type { TorrentRuntimeConfig } from '../config'
import type {
	AppDatabase,
	CacheEntry,
	StoredTorrentFile,
	TorrentStatusSummary,
	TorrentSummary,
} from '../database'
import { asError, HttpError } from '../errors'
import type { AppLogger } from '../logger'
import { torrentFileMediaType } from './mediaType'
import { type ByteRange, parseByteRange } from './range'
import {
	normalizeInfoHash,
	parseTorrentReference,
	type TorrentReference,
} from './reference'

const LEADING_SLASH_PATTERN = /^\/+/
const MAX_PENDING_NAME_LENGTH = 512
const POSIX_STAT_BLOCK_BYTES = 512

interface RuntimeTorrent extends Torrent {
	infoBuffer: Uint8Array
}

interface TorrentSession {
	activeOperations: number
	idleTimer: ReturnType<typeof setTimeout> | null
	infoHash: string
	metadataReady: Promise<RuntimeTorrent>
	ready: Promise<RuntimeTorrent>
	source: string
	torrent: RuntimeTorrent
}

interface DeferredSignal {
	promise: Promise<void>
	release: () => void
}

const createDeferredSignal = (): DeferredSignal => {
	let release = (): void => undefined
	const promise = new Promise<void>((resolve) => {
		release = resolve
	})
	return { promise, release }
}

export interface TorrentFileDetails {
	downloaded: number
	id: string
	length: number
	mimeType: string
	name: string
	path: string[]
	progress: number
}

export interface TorrentDetails {
	downloaded: number
	downloadSpeed: number
	files: TorrentFileDetails[]
	infoHash: string
	length: number
	magnetUri: string
	name: string
	numPeers: number
	progress: number
	ready: boolean
}

export interface TorrentRegistration {
	backgroundDownload: boolean
	infoHash: string
	metadataReady: boolean
}

export interface TorrentServiceHealth {
	activeSessions: number
	destroyed: boolean
	preloadJobs: number
}

export type PreloadState = 'completed' | 'failed' | 'running'

export type TorrentActivityState =
	| 'completed'
	| 'downloading'
	| 'failed'
	| 'fetching_metadata'
	| 'idle'

export interface PreloadStatus {
	downloadedBytes: number
	error?: string
	finishedAt?: string
	infoHash: string
	startedAt: string
	state: PreloadState
	totalBytes: number
}

export interface TorrentStatus {
	downloadedBytes: number
	downloadSpeed: number
	error?: string
	finishedAt?: string
	infoHash: string
	metadataReady: boolean
	name: string
	numPeers: number
	progress: number
	startedAt?: string
	state: TorrentActivityState
	totalBytes: number
}

export interface TorrentListItem extends TorrentSummary {
	downloadedBytes: number
	downloadSpeed: number
	error?: string
	finishedAt?: string
	metadataReady: boolean
	numPeers: number
	progress: number
	startedAt?: string
	state: TorrentActivityState
	totalBytes: number
}

export interface OpenedTorrentFile {
	contentLength: number
	file: TorrentFileDetails
	range: ByteRange | null
	released?: Promise<void>
	stream: ReadableStream<Uint8Array> | null
}

export interface OpenedCachedTorrentFile extends OpenedTorrentFile {
	localPath: string
}

export interface TorrentManagerOptions {
	client?: WebTorrent
	config: TorrentRuntimeConfig
	database: AppDatabase
	logger: AppLogger
}

export type CacheCompletedListener = (infoHash: string) => void

const createEventPromise = (
	torrent: RuntimeTorrent,
	event: 'metadata' | 'ready'
): Promise<RuntimeTorrent> => {
	if (event === 'metadata' && torrent.files.length > 0) {
		return Promise.resolve(torrent)
	}
	if (event === 'ready' && torrent.ready) {
		return Promise.resolve(torrent)
	}
	const promise = new Promise<RuntimeTorrent>((resolve, reject) => {
		const onEvent = (): void => {
			cleanup()
			resolve(torrent)
		}
		const onError = (value: Error | string): void => {
			cleanup()
			reject(asError(value))
		}
		const onClose = (): void => {
			cleanup()
			reject(new Error(`Torrent closed before ${event}`))
		}
		const cleanup = (): void => {
			torrent.off(event, onEvent)
			torrent.off('error', onError)
			torrent.off('close', onClose)
		}
		torrent.once(event, onEvent)
		torrent.once('error', onError)
		torrent.once('close', onClose)
	})
	// Sessions can be registered without an immediate request. Attach a rejection
	// handler now so a peer failure never becomes an unhandled process rejection.
	promise.catch(() => undefined)
	return promise
}

const waitFor = async <Value>(
	promise: Promise<Value>,
	timeoutMs: number,
	signal?: AbortSignal
): Promise<Value> => {
	if (signal?.aborted) {
		throw new HttpError(499, 'request_cancelled', 'Request was cancelled')
	}
	return await new Promise<Value>((resolve, reject) => {
		const timeout = setTimeout(() => {
			cleanup()
			reject(
				new HttpError(
					504,
					'metadata_timeout',
					'Torrent metadata was not available before the timeout'
				)
			)
		}, timeoutMs)
		const onAbort = (): void => {
			cleanup()
			reject(new HttpError(499, 'request_cancelled', 'Request was cancelled'))
		}
		const cleanup = (): void => {
			clearTimeout(timeout)
			signal?.removeEventListener('abort', onAbort)
		}
		signal?.addEventListener('abort', onAbort, { once: true })
		promise.then(
			(value) => {
				cleanup()
				resolve(value)
			},
			(error: unknown) => {
				cleanup()
				reject(error)
			}
		)
	})
}

const preloadCancelledError = (): Error => {
	const error = new Error('Torrent background download was cancelled')
	error.name = 'AbortError'
	return error
}

const waitForSignal = async <Value>(
	promise: Promise<Value>,
	signal: AbortSignal
): Promise<Value> => {
	if (signal.aborted) {
		throw preloadCancelledError()
	}
	return await new Promise<Value>((resolve, reject) => {
		const cleanup = (): void => {
			signal.removeEventListener('abort', onAbort)
		}
		const onAbort = (): void => {
			cleanup()
			reject(preloadCancelledError())
		}
		signal.addEventListener('abort', onAbort, { once: true })
		promise.then(
			(value) => {
				cleanup()
				resolve(value)
			},
			(error: unknown) => {
				cleanup()
				reject(error)
			}
		)
	})
}

const normalizeFilePath = (path: string): string =>
	path.replaceAll('\\', '/').replace(LEADING_SLASH_PATTERN, '')

const filePathParts = (path: string): string[] =>
	normalizeFilePath(path).split('/').filter(Boolean)

const pendingTorrentName = (reference: TorrentReference): string => {
	if (URL.canParse(reference.torrentId)) {
		const displayName = new URL(reference.torrentId).searchParams
			.get('dn')
			?.trim()
		if (displayName) {
			return displayName.slice(0, MAX_PENDING_NAME_LENGTH)
		}
	}
	return `Torrent ${reference.infoHash}`
}

const torrentActivityState = ({
	completedCache,
	metadataReady,
	preloadState,
	sessionActive,
	torrentDone,
}: {
	completedCache: boolean
	metadataReady: boolean
	preloadState?: PreloadState
	sessionActive: boolean
	torrentDone: boolean
}): TorrentActivityState => {
	if (completedCache || torrentDone) {
		return 'completed'
	}
	if (preloadState === 'failed') {
		return 'failed'
	}
	if (!metadataReady && (preloadState === 'running' || sessionActive)) {
		return 'fetching_metadata'
	}
	return preloadState === 'running' ? 'downloading' : 'idle'
}

const torrentProgress = (
	downloadedBytes: number,
	totalBytes: number,
	state: TorrentActivityState
): number => {
	if (totalBytes > 0) {
		return Math.min(1, downloadedBytes / totalBytes)
	}
	return state === 'completed' ? 1 : 0
}

const displayPath = (torrent: Torrent, file: TorrentFile): string[] => {
	const parts = filePathParts(file.path)
	if (parts.length > 1 && parts[0] === torrent.name) {
		return parts.slice(1)
	}
	return parts
}

const storedTorrentFile = (
	torrent: Torrent,
	file: TorrentFile,
	index: number
): StoredTorrentFile => ({
	fileId: String(index),
	length: file.length,
	mimeType: torrentFileMediaType(file.name, file.type),
	name: file.name,
	path: displayPath(torrent, file),
	storagePath: filePathParts(file.path),
})

const cachedFileDetails = (file: StoredTorrentFile): TorrentFileDetails => ({
	downloaded: file.length,
	id: file.fileId,
	length: file.length,
	mimeType: file.mimeType,
	name: file.name,
	path: file.path,
	progress: 1,
})

const isContainedPath = (root: string, candidate: string): boolean => {
	const fromRoot = relative(root, candidate)
	return (
		fromRoot.length > 0 &&
		fromRoot !== '..' &&
		!fromRoot.startsWith(`..${sep}`) &&
		!isAbsolute(fromRoot)
	)
}

const fileDetails = (
	torrent: Torrent,
	file: TorrentFile,
	index: number
): TorrentFileDetails => ({
	downloaded: file.downloaded,
	id: String(index),
	length: file.length,
	mimeType: torrentFileMediaType(file.name, file.type),
	name: file.name,
	path: displayPath(torrent, file),
	progress: file.progress,
})

interface BoundedStreamHandle {
	released: Promise<void>
	stream: ReadableStream<Uint8Array>
}

interface ValidatedCachedFile {
	file: TorrentFileDetails
	localPath: string
	stored: StoredTorrentFile
}

const boundedStream = (
	source: ReadableStream<Uint8Array>,
	maximumBytes: number,
	onFinalize: () => void,
	signal?: AbortSignal
): BoundedStreamHandle => {
	const reader = source.getReader()
	const released = createDeferredSignal()
	let remaining = maximumBytes
	let finalized = false
	const finalize = (): void => {
		if (finalized) {
			return
		}
		finalized = true
		signal?.removeEventListener('abort', onAbort)
		try {
			onFinalize()
		} finally {
			released.release()
		}
	}
	const cancelSource = async (reason?: unknown): Promise<void> => {
		try {
			await reader.cancel(reason)
		} finally {
			finalize()
		}
	}
	const onAbort = (): void => {
		const error = new Error('Stream was cancelled')
		error.name = 'AbortError'
		cancelSource(error).catch(() => undefined)
	}
	if (signal?.aborted) {
		onAbort()
	} else {
		signal?.addEventListener('abort', onAbort, { once: true })
	}
	const stream = new ReadableStream<Uint8Array>({
		async cancel(reason) {
			await cancelSource(reason)
		},
		async pull(controller) {
			try {
				const { done, value } = await reader.read()
				if (done || remaining === 0) {
					controller.close()
					await cancelSource()
					return
				}
				const chunk =
					value.byteLength > remaining ? value.subarray(0, remaining) : value
				remaining -= chunk.byteLength
				controller.enqueue(chunk)
				if (remaining === 0) {
					controller.close()
					await cancelSource()
				}
			} catch (error) {
				controller.error(error)
				await cancelSource(error).catch(() => undefined)
			}
		},
	})
	return { released: released.promise, stream }
}

export class TorrentManager {
	private readonly cacheCompletedListeners = new Set<CacheCompletedListener>()
	private readonly cacheEvictionPromises = new Map<string, Promise<void>>()
	private readonly client: WebTorrent
	private readonly completedStatePromises = new Map<string, Promise<void>>()
	private readonly config: TorrentRuntimeConfig
	private readonly database: AppDatabase
	private readonly directCacheReaderCounts = new Map<string, number>()
	private readonly directCacheReaderWaiters = new Map<string, Set<() => void>>()
	private readonly idleDropPromises = new Map<string, Promise<void>>()
	private readonly logger: AppLogger
	private readonly preloadAbortControllers = new Map<string, AbortController>()
	private readonly preloadJobs = new Map<string, PreloadStatus>()
	private readonly preloadPromises = new Map<string, Promise<void>>()
	private readonly removalPromises = new Map<string, Promise<boolean>>()
	private readonly sessions = new Map<string, TorrentSession>()
	private closing: boolean

	constructor({ client, config, database, logger }: TorrentManagerOptions) {
		this.closing = false
		this.config = config
		this.database = database
		this.logger = logger
		this.client =
			client ??
			new WebTorrent({
				dht: config.dht,
				lsd: config.localServiceDiscovery,
				maxConns: config.maxConnections,
				natPmp: false,
				natUpnp: false,
				torrentPort: config.torrentPort,
				tracker: config.trackers,
				utPex: config.peerExchange,
				utp: config.utp,
			})
		this.client.on('error', (error) => {
			this.logger.error('WebTorrent client error', {
				error: asError(error).message,
			})
		})
		this.restoreBackgroundDownloads()
	}

	async close(): Promise<void> {
		if (this.closing) {
			return
		}
		this.closing = true
		for (const controller of this.preloadAbortControllers.values()) {
			controller.abort()
		}
		for (const session of this.sessions.values()) {
			if (session.idleTimer) {
				clearTimeout(session.idleTimer)
			}
		}
		await Promise.allSettled([...this.removalPromises.values()])
		await Promise.allSettled([...this.idleDropPromises.values()])
		await Promise.allSettled([...this.cacheEvictionPromises.values()])
		const sessions = [...this.sessions.values()]
		await Promise.all(
			sessions.map(async (session) => {
				if (!session.torrent.done) {
					return
				}
				try {
					await this.saveCompletedState(session)
				} catch (error) {
					this.logger.warn('Unable to save torrent state during shutdown', {
						error: asError(error).message,
						infoHash: session.infoHash,
					})
				}
			})
		)
		await Promise.allSettled([...this.completedStatePromises.values()])
		if (!this.client.destroyed) {
			await new Promise<void>((resolve, reject) => {
				this.client.destroy((error) => {
					if (error && !this.client.destroyed) {
						reject(error)
						return
					}
					resolve()
				})
			})
		}
		await Promise.allSettled([...this.preloadPromises.values()])
		this.sessions.clear()
		await Promise.all(
			sessions.map(async (session) => {
				if (!this.database.getMetadata(session.infoHash)) {
					return
				}
				const bytes = await this.measureCacheBytes(session.infoHash)
				this.database.recordCache(session.infoHash, bytes, session.torrent.done)
			})
		)
		await this.pruneCache()
	}

	async details(
		infoHash: string,
		signal?: AbortSignal
	): Promise<TorrentDetails> {
		const session = this.acquireByInfoHash(infoHash)
		try {
			const torrent = await waitFor(
				session.metadataReady,
				this.config.metadataTimeoutMs,
				signal
			)
			this.database.touchTorrent(session.infoHash)
			return this.toDetails(torrent)
		} finally {
			this.release(session)
		}
	}

	async infoBytes(infoHash: string, signal?: AbortSignal): Promise<Uint8Array> {
		const session = this.acquireByInfoHash(infoHash)
		try {
			const torrent = await waitFor(
				session.metadataReady,
				this.config.metadataTimeoutMs,
				signal
			)
			this.database.touchTorrent(session.infoHash)
			return torrent.infoBuffer
		} finally {
			this.release(session)
		}
	}

	health(): TorrentServiceHealth {
		return {
			activeSessions: this.sessions.size,
			destroyed: this.client.destroyed,
			preloadJobs: [...this.preloadJobs.values()].filter(
				(job) => job.state === 'running'
			).length,
		}
	}

	list(): TorrentListItem[] {
		return this.database.listTorrentStatusSummaries().map((summary) => ({
			cachedBytes: summary.cachedBytes,
			firstSeen: summary.firstSeen,
			lastSeen: summary.lastSeen,
			...this.statusFromSummary(summary),
		}))
	}

	onCacheCompleted(listener: CacheCompletedListener): () => void {
		this.cacheCompletedListeners.add(listener)
		return () => {
			this.cacheCompletedListeners.delete(listener)
		}
	}

	async cachedFiles(infoHash: string): Promise<TorrentFileDetails[]> {
		const normalized = normalizeInfoHash(infoHash)
		const summary = this.database.getTorrentStatusSummary(normalized)
		if (!(summary?.metadataCompleted && summary.cacheCompleted)) {
			throw new HttpError(
				409,
				'audio_not_local',
				'The audiobook must finish downloading before transcription'
			)
		}
		return (await this.loadStoredFiles(normalized)).map(cachedFileDetails)
	}

	async cachedFile(
		infoHash: string,
		fileId: string,
		signal?: AbortSignal
	): Promise<TorrentFileDetails> {
		const normalized = normalizeInfoHash(infoHash)
		this.assertRequestActive(signal)
		const releaseLease = this.acquireDirectCacheReader(normalized)
		try {
			const validated = await this.validateCachedFile(
				normalized,
				fileId,
				signal
			)
			this.database.touchTorrent(normalized)
			return validated.file
		} catch (error) {
			return this.throwCachedFileError(error)
		} finally {
			releaseLease()
		}
	}

	async openCachedFile(
		infoHash: string,
		fileId: string,
		signal?: AbortSignal
	): Promise<OpenedCachedTorrentFile> {
		const normalized = normalizeInfoHash(infoHash)
		this.assertRequestActive(signal)
		const releaseLease = this.acquireDirectCacheReader(normalized)
		let streamOwnsLease = false
		try {
			const { file, localPath, stored } = await this.validateCachedFile(
				normalized,
				fileId,
				signal
			)
			this.database.touchTorrent(normalized)
			if (stored.length === 0) {
				return {
					contentLength: 0,
					file,
					localPath,
					range: null,
					stream: null,
				}
			}
			const bounded = boundedStream(
				openBunFile(localPath).stream(),
				stored.length,
				releaseLease,
				signal
			)
			streamOwnsLease = true
			return {
				contentLength: stored.length,
				file,
				localPath,
				range: null,
				released: bounded.released,
				stream: bounded.stream,
			}
		} catch (error) {
			return this.throwCachedFileError(error)
		} finally {
			if (!streamOwnsLease) {
				releaseLease()
			}
		}
	}

	async openFile(
		infoHash: string,
		fileId: string,
		rangeHeader?: string,
		signal?: AbortSignal
	): Promise<OpenedTorrentFile> {
		const session = this.acquireByInfoHash(infoHash)
		let streamOwnsSession = false
		try {
			const torrent = await waitFor(
				session.ready,
				this.config.metadataTimeoutMs,
				signal
			)
			const index = Number(fileId)
			if (!(Number.isSafeInteger(index) && index >= 0)) {
				throw new HttpError(404, 'file_not_found', 'Torrent file was not found')
			}
			const file = torrent.files[index]
			if (!file) {
				throw new HttpError(404, 'file_not_found', 'Torrent file was not found')
			}
			const range = parseByteRange(rangeHeader, file.length)
			const contentLength = range?.length ?? file.length
			this.database.touchTorrent(session.infoHash)
			if (contentLength === 0) {
				return {
					contentLength,
					file: fileDetails(torrent, file, index),
					range,
					stream: null,
				}
			}
			const source = range
				? file.stream({
						end: range.end === 0 ? Math.min(1, file.length - 1) : range.end,
						start: range.start,
					})
				: file.stream()
			streamOwnsSession = true
			const bounded = boundedStream(source, contentLength, () =>
				this.release(session)
			)
			return {
				contentLength,
				file: fileDetails(torrent, file, index),
				range,
				released: bounded.released,
				stream: bounded.stream,
			}
		} finally {
			if (!streamOwnsSession) {
				this.release(session)
			}
		}
	}

	async openFileByPath(
		infoHash: string,
		path: string,
		rangeHeader?: string,
		signal?: AbortSignal
	): Promise<OpenedTorrentFile> {
		const details = await this.details(infoHash, signal)
		const requestedPath = normalizeFilePath(path)
		const file = details.files.find(
			(candidate) => candidate.path.join('/') === requestedPath
		)
		if (!file) {
			throw new HttpError(404, 'file_not_found', 'Torrent file was not found')
		}
		return await this.openFile(infoHash, file.id, rangeHeader, signal)
	}

	preloadStatus(infoHash: string): PreloadStatus | null {
		return this.preloadJobs.get(normalizeInfoHash(infoHash)) ?? null
	}

	register(
		source: string,
		{ backgroundDownload = false }: { backgroundDownload?: boolean } = {}
	): TorrentRegistration {
		if (this.closing) {
			throw new HttpError(503, 'server_stopping', 'Torrent service is stopping')
		}
		const reference = parseTorrentReference(source)
		this.assertNotRemoving(reference.infoHash)
		const pendingName = pendingTorrentName(reference)
		this.database.recordTorrentRegistration(
			reference.infoHash,
			pendingName,
			reference.torrentId,
			backgroundDownload
		)
		const existing = this.sessions.get(reference.infoHash)
		const persisted = this.database.getTorrentStatusSummary(reference.infoHash)
		const completedCache = Boolean(
			persisted?.metadataCompleted && persisted.cacheCompleted
		)
		const session =
			existing ?? (completedCache ? null : this.createSession(reference))
		if (backgroundDownload && !completedCache) {
			const existingJob = this.preloadJobs.get(reference.infoHash)
			if (!existingJob || existingJob.state === 'failed') {
				this.startPreload(reference.infoHash)
			}
		}
		const metadataReady =
			completedCache || Boolean(session?.torrent.files.length)
		this.logger.info('Torrent registered', {
			backgroundDownload,
			infoHash: reference.infoHash,
			metadataReady,
			name:
				session?.torrent.name ??
				this.database.getTorrentSummary(reference.infoHash)?.name ??
				pendingName,
		})
		return {
			backgroundDownload,
			infoHash: reference.infoHash,
			metadataReady,
		}
	}

	status(infoHash: string): TorrentStatus {
		const normalized = normalizeInfoHash(infoHash)
		const summary = this.database.getTorrentStatusSummary(normalized)
		if (!summary) {
			throw new HttpError(404, 'torrent_not_found', 'Torrent was not found')
		}
		return this.statusFromSummary(summary)
	}

	async remove(
		infoHash: string,
		beforeRemoval?: () => Promise<void>
	): Promise<boolean> {
		if (this.closing) {
			throw new HttpError(503, 'server_stopping', 'Torrent service is stopping')
		}
		const normalized = normalizeInfoHash(infoHash)
		const existing = this.removalPromises.get(normalized)
		if (existing) {
			return await existing
		}
		const reservation = createDeferredSignal()
		const promise = this.performReservedRemoval(
			normalized,
			reservation.promise,
			beforeRemoval
		).finally(() => {
			if (this.removalPromises.get(normalized) === promise) {
				this.removalPromises.delete(normalized)
			}
		})
		this.removalPromises.set(normalized, promise)
		reservation.release()
		return await promise
	}

	isRemoving(infoHash: string): boolean {
		return this.removalPromises.has(normalizeInfoHash(infoHash))
	}

	startPreload(infoHash: string): PreloadStatus {
		if (this.closing) {
			throw new HttpError(503, 'server_stopping', 'Torrent service is stopping')
		}
		const normalized = normalizeInfoHash(infoHash)
		this.assertNotRemoving(normalized)
		const existing = this.preloadJobs.get(normalized)
		if (existing?.state === 'running') {
			return existing
		}
		const status: PreloadStatus = {
			downloadedBytes: 0,
			infoHash: normalized,
			startedAt: new Date().toISOString(),
			state: 'running',
			totalBytes: 0,
		}
		this.preloadJobs.set(normalized, status)
		this.logger.info('Torrent background download started', {
			infoHash: normalized,
		})
		const controller = new AbortController()
		this.preloadAbortControllers.set(normalized, controller)
		const promise = this.executePreload(status, controller.signal)
			.catch((error: unknown) => {
				if (controller.signal.aborted) {
					return
				}
				status.error = asError(error).message
				status.finishedAt = new Date().toISOString()
				status.state = 'failed'
				if (!(this.closing || this.isRemoving(normalized))) {
					this.logger.error('Torrent preload failed', {
						error: status.error,
						infoHash: normalized,
					})
				}
			})
			.finally(() => {
				if (this.preloadPromises.get(normalized) === promise) {
					this.preloadPromises.delete(normalized)
				}
				if (this.preloadAbortControllers.get(normalized) === controller) {
					this.preloadAbortControllers.delete(normalized)
				}
			})
		this.preloadPromises.set(normalized, promise)
		return status
	}

	private assertNotRemoving(infoHash: string): void {
		if (this.isRemoving(infoHash)) {
			throw new HttpError(
				409,
				'torrent_removing',
				'Torrent removal is already in progress'
			)
		}
	}

	private acquireDirectCacheReader(infoHash: string): () => void {
		if (this.closing) {
			throw new HttpError(503, 'server_stopping', 'Torrent service is stopping')
		}
		this.assertNotRemoving(infoHash)
		if (this.cacheEvictionPromises.has(infoHash)) {
			throw new HttpError(
				409,
				'audio_not_local',
				'The audiobook is being removed from the local cache'
			)
		}
		this.directCacheReaderCounts.set(
			infoHash,
			(this.directCacheReaderCounts.get(infoHash) ?? 0) + 1
		)
		let released = false
		return () => {
			if (released) {
				return
			}
			released = true
			this.releaseDirectCacheReader(infoHash)
		}
	}

	private assertRequestActive(signal?: AbortSignal): void {
		if (signal?.aborted) {
			throw new HttpError(499, 'request_cancelled', 'Request was cancelled')
		}
	}

	private releaseDirectCacheReader(infoHash: string): void {
		const remaining = Math.max(
			0,
			(this.directCacheReaderCounts.get(infoHash) ?? 1) - 1
		)
		if (remaining > 0) {
			this.directCacheReaderCounts.set(infoHash, remaining)
			return
		}
		this.directCacheReaderCounts.delete(infoHash)
		const waiters = this.directCacheReaderWaiters.get(infoHash)
		this.directCacheReaderWaiters.delete(infoHash)
		for (const resolve of waiters ?? []) {
			resolve()
		}
		if (this.closing || this.isRemoving(infoHash)) {
			return
		}
		queueMicrotask(() => {
			this.pruneCache().catch((error: unknown) => {
				this.logger.warn('Unable to prune cache after a local reader closed', {
					error: asError(error).message,
					infoHash,
				})
			})
		})
	}

	private async waitForDirectCacheReaders(infoHash: string): Promise<void> {
		if (!this.directCacheReaderCounts.has(infoHash)) {
			return
		}
		await new Promise<void>((resolve) => {
			const waiters =
				this.directCacheReaderWaiters.get(infoHash) ?? new Set<() => void>()
			waiters.add(resolve)
			this.directCacheReaderWaiters.set(infoHash, waiters)
		})
	}

	private acquireByInfoHash(infoHash: string): TorrentSession {
		if (this.closing) {
			throw new HttpError(503, 'server_stopping', 'Torrent service is stopping')
		}
		const normalized = normalizeInfoHash(infoHash)
		this.assertNotRemoving(normalized)
		const existing = this.sessions.get(normalized)
		const session =
			existing ??
			this.createSession({ infoHash: normalized, torrentId: normalized })
		if (session.idleTimer) {
			clearTimeout(session.idleTimer)
			session.idleTimer = null
		}
		session.activeOperations += 1
		return session
	}

	private cachePath(infoHash: string): string {
		return join(this.config.cacheDirectory, normalizeInfoHash(infoHash))
	}

	private async loadStoredFiles(
		infoHash: string
	): Promise<StoredTorrentFile[]> {
		const stored = this.database.listTorrentFiles(infoHash)
		if (stored.length > 0) {
			return stored
		}
		const metadata = this.database.getMetadata(infoHash)
		if (!metadata) {
			throw new HttpError(404, 'torrent_not_found', 'Torrent was not found')
		}
		try {
			const parsed = await parseTorrent(metadata.torrentFile)
			if (normalizeInfoHash(parsed.infoHash) !== infoHash) {
				throw new Error('Stored torrent metadata hash does not match its row')
			}
			const torrentName = parsed.name ?? ''
			const files = (parsed.files ?? []).map((file, index) => {
				const storagePath = filePathParts(file.path)
				const path =
					storagePath.length > 1 && storagePath[0] === torrentName
						? storagePath.slice(1)
						: storagePath
				return {
					fileId: String(index),
					length: file.length,
					mimeType: torrentFileMediaType(
						file.name,
						openBunFile(file.name).type
					),
					name: file.name,
					path,
					storagePath,
				} satisfies StoredTorrentFile
			})
			if (files.length === 0) {
				throw new Error('Stored torrent metadata contains no files')
			}
			this.database.replaceTorrentFiles(infoHash, files)
			return files
		} catch (error) {
			// biome-ignore lint/style/useErrorCause: HttpError forwards cause through its options argument.
			throw new HttpError(
				409,
				'audio_not_local',
				'Stored torrent metadata could not resolve local audiobook files',
				{},
				{ cause: error }
			)
		}
	}

	private throwCachedFileError(error: unknown): never {
		if (error instanceof HttpError) {
			throw error
		}
		throw new HttpError(
			409,
			'audio_not_local',
			'The audiobook file is not fully available in the local cache',
			{},
			{ cause: error }
		)
	}

	private async validateCachedFile(
		infoHash: string,
		fileId: string,
		signal?: AbortSignal
	): Promise<ValidatedCachedFile> {
		const summary = this.database.getTorrentStatusSummary(infoHash)
		if (!summary) {
			throw new HttpError(404, 'torrent_not_found', 'Torrent was not found')
		}
		const files = await this.loadStoredFiles(infoHash)
		const stored = files.find((candidate) => candidate.fileId === fileId)
		if (!stored) {
			throw new HttpError(404, 'file_not_found', 'Torrent file was not found')
		}
		const cacheRoot = resolvePath(this.cachePath(infoHash))
		const candidatePath = resolvePath(cacheRoot, ...stored.storagePath)
		if (!isContainedPath(cacheRoot, candidatePath)) {
			throw new Error('Cached torrent path escapes its cache root')
		}
		const [resolvedRoot, localPath] = await Promise.all([
			realpath(cacheRoot),
			realpath(candidatePath),
		])
		if (!isContainedPath(resolvedRoot, localPath)) {
			throw new Error('Cached torrent path resolves outside its cache root')
		}
		const fileStat = await stat(localPath)
		const allocatedBytes = fileStat.blocks * POSIX_STAT_BLOCK_BYTES
		if (
			!fileStat.isFile() ||
			fileStat.size !== stored.length ||
			allocatedBytes < stored.length
		) {
			throw new Error('Cached torrent file does not match its manifest')
		}
		this.assertRequestActive(signal)
		return {
			file: cachedFileDetails(stored),
			localPath,
			stored,
		}
	}

	private async performReservedRemoval(
		infoHash: string,
		reservation: Promise<void>,
		beforeRemoval?: () => Promise<void>
	): Promise<boolean> {
		await reservation
		await beforeRemoval?.()
		return await this.performRemoval(infoHash)
	}

	private async performRemoval(infoHash: string): Promise<boolean> {
		const cacheEvictionPromise = this.cacheEvictionPromises.get(infoHash)
		if (cacheEvictionPromise) {
			await cacheEvictionPromise
		}
		const idleDropPromise = this.idleDropPromises.get(infoHash)
		if (idleDropPromise) {
			await idleDropPromise
		}
		const completedStatePromise = this.completedStatePromises.get(infoHash)
		if (completedStatePromise) {
			await completedStatePromise
		}
		try {
			const preloadPromise = this.preloadPromises.get(infoHash)
			this.preloadAbortControllers.get(infoHash)?.abort()
			if (preloadPromise) {
				await preloadPromise
			}
			const session = this.sessions.get(infoHash)
			if (session) {
				if (session.idleTimer) {
					clearTimeout(session.idleTimer)
				}
				await this.client.remove(session.torrent, { destroyStore: false })
				this.sessions.delete(infoHash)
			}
			await this.waitForDirectCacheReaders(infoHash)
			await rm(this.cachePath(infoHash), { force: true, recursive: true })
			const removed = this.database.deleteTorrent(infoHash)
			this.logger.info('Torrent removed from server', { infoHash })
			return removed
		} finally {
			this.preloadAbortControllers.delete(infoHash)
			this.preloadJobs.delete(infoHash)
			this.preloadPromises.delete(infoHash)
		}
	}

	private createSession(reference: TorrentReference): TorrentSession {
		if (this.closing) {
			throw new HttpError(503, 'server_stopping', 'Torrent service is stopping')
		}
		const stored = this.database.getMetadata(reference.infoHash)
		const torrentOptions: TorrentOptions = {
			addUID: false,
			deselect: true,
			destroyStoreOnDestroy: false,
			path: this.cachePath(reference.infoHash),
			storeCacheSlots: 32,
			strategy: 'sequential',
		}
		if (stored?.completed && stored.fileModtimes) {
			torrentOptions.fileModtimes = stored.fileModtimes
		}
		const source = stored?.torrentFile ?? reference.torrentId
		const torrent = this.client.add(source, torrentOptions) as RuntimeTorrent
		const session: TorrentSession = {
			activeOperations: 0,
			idleTimer: null,
			infoHash: reference.infoHash,
			metadataReady: createEventPromise(torrent, 'metadata'),
			ready: createEventPromise(torrent, 'ready'),
			source: reference.torrentId,
			torrent,
		}
		this.sessions.set(reference.infoHash, session)
		torrent.once('metadata', () => this.onMetadata(session))
		torrent.once('done', () => {
			if (this.closing || this.isRemoving(session.infoHash)) {
				return
			}
			this.recordCompletedCache(session).catch((error: unknown) => {
				this.logger.warn('Unable to save completed torrent state', {
					error: asError(error).message,
					infoHash: session.infoHash,
				})
			})
		})
		torrent.on('warning', (warning) => {
			this.logger.warn('WebTorrent warning', {
				infoHash: session.infoHash,
				warning: asError(warning).message,
			})
		})
		torrent.on('error', (error) => {
			this.logger.error('Torrent session error', {
				error: asError(error).message,
				infoHash: session.infoHash,
			})
		})
		torrent.once('close', () => {
			if (this.sessions.get(session.infoHash) === session) {
				this.sessions.delete(session.infoHash)
			}
		})
		this.release(session)
		return session
	}

	private async dropIdleSession(session: TorrentSession): Promise<void> {
		if (
			this.closing ||
			this.isRemoving(session.infoHash) ||
			session.activeOperations > 0 ||
			this.sessions.get(session.infoHash) !== session
		) {
			return
		}
		const completed = session.torrent.done
		if (completed) {
			await this.saveCompletedState(session)
		}
		await this.client.remove(session.torrent, { destroyStore: false })
		this.sessions.delete(session.infoHash)
		const bytes = await this.measureCacheBytes(session.infoHash)
		if (this.database.getMetadata(session.infoHash)) {
			this.database.recordCache(session.infoHash, bytes, completed)
		} else {
			await rm(this.cachePath(session.infoHash), {
				force: true,
				recursive: true,
			})
		}
		await this.pruneCache()
		this.logger.debug('Dropped idle torrent session', {
			cachedBytes: bytes,
			infoHash: session.infoHash,
		})
	}

	private async consumePreloadFile(
		file: TorrentFile,
		status: PreloadStatus,
		signal: AbortSignal
	): Promise<void> {
		const reader = file.stream().getReader()
		try {
			// biome-ignore lint/suspicious/noUnnecessaryConditions: The stream ends through the done result below.
			while (true) {
				// biome-ignore lint/performance/noAwaitInLoops: A file stream must be consumed sequentially and remains abortable.
				const { done, value } = await waitForSignal(reader.read(), signal)
				if (done) {
					return
				}
				status.downloadedBytes += value.byteLength
			}
		} finally {
			if (signal.aborted) {
				reader.cancel(preloadCancelledError()).catch(() => undefined)
			} else {
				reader.releaseLock()
			}
		}
	}

	private async executePreload(
		status: PreloadStatus,
		signal: AbortSignal
	): Promise<void> {
		const session = this.acquireByInfoHash(status.infoHash)
		try {
			const torrent = await waitForSignal(session.ready, signal)
			status.totalBytes = torrent.length
			for (const file of torrent.files) {
				// biome-ignore lint/performance/noAwaitInLoops: Consume files sequentially to keep server preload memory bounded.
				await this.consumePreloadFile(file, status, signal)
			}
			status.downloadedBytes = torrent.length
			if (this.closing || this.isRemoving(session.infoHash)) {
				return
			}
			await this.saveCompletedState(session)
			const bytes = await this.measureCacheBytes(session.infoHash)
			this.database.recordCache(session.infoHash, bytes, true)
			await this.pruneCache()
			status.finishedAt = new Date().toISOString()
			status.state = 'completed'
			this.notifyCacheCompleted(session.infoHash)
			this.logger.info('Torrent background download completed', {
				downloadedBytes: status.downloadedBytes,
				infoHash: session.infoHash,
				totalBytes: status.totalBytes,
			})
		} finally {
			this.release(session)
		}
	}

	private notifyCacheCompleted(infoHash: string): void {
		for (const listener of this.cacheCompletedListeners) {
			try {
				listener(infoHash)
			} catch (error) {
				this.logger.warn('Torrent cache completion listener failed', {
					error: asError(error).message,
					infoHash,
				})
			}
		}
	}

	private async recordCompletedCache(session: TorrentSession): Promise<void> {
		await this.saveCompletedState(session)
		const bytes = await this.measureCacheBytes(session.infoHash)
		if (
			this.closing ||
			this.isRemoving(session.infoHash) ||
			!this.database.getTorrentSummary(session.infoHash)
		) {
			return
		}
		this.database.recordCache(session.infoHash, bytes, true)
		this.notifyCacheCompleted(session.infoHash)
	}

	private restoreBackgroundDownloads(): void {
		const persistedByInfoHash = new Map(
			this.database
				.listTorrentStatusSummaries()
				.map((summary) => [summary.infoHash, summary] as const)
		)
		for (const registration of this.database.listTorrentRegistrations()) {
			if (!registration.backgroundDownload) {
				continue
			}
			const persisted = persistedByInfoHash.get(registration.infoHash)
			const completedCache = Boolean(
				persisted?.metadataCompleted && persisted.cacheCompleted
			)
			if (completedCache) {
				continue
			}
			try {
				this.createSession({
					infoHash: registration.infoHash,
					torrentId: registration.torrentId,
				})
				this.startPreload(registration.infoHash)
				this.logger.info('Restored background torrent download', {
					infoHash: registration.infoHash,
				})
			} catch (error) {
				this.logger.error('Unable to restore background torrent download', {
					error: asError(error).message,
					infoHash: registration.infoHash,
				})
			}
		}
	}

	private async measureCacheBytes(infoHash: string): Promise<number> {
		const root = this.cachePath(infoHash)
		const visit = async (directory: string): Promise<number> => {
			let entries: Dirent[]
			try {
				entries = await readdir(directory, { withFileTypes: true })
			} catch (error) {
				if (asError(error).message.includes('ENOENT')) {
					return 0
				}
				throw error
			}
			const sizes = await Promise.all(
				entries.map(async (entry) => {
					const path = join(directory, entry.name)
					if (entry.isDirectory()) {
						return await visit(path)
					}
					if (!entry.isFile()) {
						return 0
					}
					const fileStat = await stat(path)
					return fileStat.blocks * 512
				})
			)
			return sizes.reduce((total, size) => total + size, 0)
		}
		return await visit(root)
	}

	private onMetadata(session: TorrentSession): void {
		if (this.closing || this.isRemoving(session.infoHash)) {
			return
		}
		const { torrent } = session
		if (torrent.infoHash !== session.infoHash) {
			this.logger.error('Torrent metadata hash mismatch', {
				actualInfoHash: torrent.infoHash,
				expectedInfoHash: session.infoHash,
			})
			torrent.destroy()
			return
		}
		this.database.upsertTorrent(
			session.infoHash,
			torrent.name,
			torrent.torrentFile,
			torrent.magnetURI
		)
		this.database.replaceTorrentFiles(
			session.infoHash,
			torrent.files.map((file, index) =>
				storedTorrentFile(torrent, file, index)
			)
		)
		this.logger.info('Torrent metadata ready', {
			files: torrent.files.length,
			infoHash: session.infoHash,
			name: torrent.name,
		})
	}

	private async pruneCache(): Promise<void> {
		const entries = this.database.listCacheEntries()
		let total = entries.reduce((sum, entry) => sum + entry.bytes, 0)
		const victims: CacheEntry[] = []
		for (const entry of entries) {
			if (total <= this.config.cacheCapacityBytes) {
				break
			}
			if (
				this.sessions.has(entry.infoHash) ||
				this.directCacheReaderCounts.has(entry.infoHash) ||
				this.cacheEvictionPromises.has(entry.infoHash) ||
				this.isRemoving(entry.infoHash)
			) {
				continue
			}
			victims.push(entry)
			total -= entry.bytes
		}
		const evictions = victims.map((entry) => {
			const promise = this.evictCacheEntry(entry).finally(() => {
				if (this.cacheEvictionPromises.get(entry.infoHash) === promise) {
					this.cacheEvictionPromises.delete(entry.infoHash)
				}
			})
			this.cacheEvictionPromises.set(entry.infoHash, promise)
			return promise
		})
		await Promise.all(evictions)
	}

	private async evictCacheEntry(entry: CacheEntry): Promise<void> {
		await rm(this.cachePath(entry.infoHash), {
			force: true,
			recursive: true,
		})
		this.database.removeCacheEntry(entry.infoHash)
		this.preloadJobs.delete(entry.infoHash)
		this.logger.info('Evicted torrent cache entry', {
			bytes: entry.bytes,
			infoHash: entry.infoHash,
		})
	}

	private release(session: TorrentSession): void {
		session.activeOperations = Math.max(0, session.activeOperations - 1)
		if (
			this.closing ||
			this.isRemoving(session.infoHash) ||
			session.activeOperations > 0 ||
			this.sessions.get(session.infoHash) !== session
		) {
			return
		}
		if (session.idleTimer) {
			clearTimeout(session.idleTimer)
		}
		session.idleTimer = setTimeout(() => {
			this.startIdleDrop(session)
		}, this.config.graceMs)
	}

	private startIdleDrop(session: TorrentSession): void {
		if (
			this.closing ||
			this.isRemoving(session.infoHash) ||
			this.idleDropPromises.has(session.infoHash)
		) {
			return
		}
		const promise = this.dropIdleSession(session)
			.catch((error: unknown) => {
				if (!(this.closing || this.isRemoving(session.infoHash))) {
					this.logger.error('Unable to drop idle torrent session', {
						error: asError(error).message,
						infoHash: session.infoHash,
					})
				}
			})
			.finally(() => {
				if (this.idleDropPromises.get(session.infoHash) === promise) {
					this.idleDropPromises.delete(session.infoHash)
				}
			})
		this.idleDropPromises.set(session.infoHash, promise)
	}

	private async saveCompletedState(session: TorrentSession): Promise<void> {
		const existing = this.completedStatePromises.get(session.infoHash)
		if (existing) {
			await existing
			return
		}
		const promise = new Promise<number[]>((resolve, reject) => {
			session.torrent.getFileModtimes((error, values) => {
				if (error) {
					reject(error)
					return
				}
				resolve(values ?? [])
			})
		})
			.then((fileModtimes) => {
				this.database.saveFileModtimes(session.infoHash, fileModtimes, true)
			})
			.finally(() => {
				if (this.completedStatePromises.get(session.infoHash) === promise) {
					this.completedStatePromises.delete(session.infoHash)
				}
			})
		this.completedStatePromises.set(session.infoHash, promise)
		await promise
	}

	private statusFromSummary(summary: TorrentStatusSummary): TorrentStatus {
		const session = this.sessions.get(summary.infoHash)
		const torrent = session?.torrent
		const completedCache = summary.metadataCompleted && summary.cacheCompleted
		const retainedPreload = this.preloadJobs.get(summary.infoHash)
		const staleCompletedPreload =
			retainedPreload?.state === 'completed' &&
			!completedCache &&
			torrent?.done !== true
		const preload = staleCompletedPreload ? undefined : retainedPreload
		const metadataReady =
			Boolean(torrent?.files.length) || summary.metadataReady
		const activeTotalBytes = torrent?.files.length
			? torrent.length
			: preload?.totalBytes
		const totalBytes =
			activeTotalBytes && activeTotalBytes > 0
				? activeTotalBytes
				: summary.totalFileBytes
		const retainedBytes =
			totalBytes > 0
				? Math.min(summary.cachedBytes, totalBytes)
				: summary.cachedBytes
		const observedDownloadedBytes = Math.max(
			retainedBytes,
			preload?.downloadedBytes ?? 0,
			torrent?.downloaded ?? 0
		)
		const downloadedBytes =
			totalBytes > 0
				? Math.min(observedDownloadedBytes, totalBytes)
				: observedDownloadedBytes
		const state = torrentActivityState({
			completedCache,
			metadataReady,
			preloadState: preload?.state,
			sessionActive: Boolean(session),
			torrentDone: torrent?.done ?? false,
		})
		const progress = torrentProgress(downloadedBytes, totalBytes, state)
		return {
			downloadedBytes,
			downloadSpeed: torrent?.downloadSpeed ?? 0,
			error: preload?.error,
			finishedAt: preload?.finishedAt,
			infoHash: summary.infoHash,
			metadataReady,
			name: metadataReady && torrent?.name ? torrent.name : summary.name,
			numPeers: torrent?.numPeers ?? 0,
			progress,
			startedAt: preload?.startedAt,
			state,
			totalBytes,
		}
	}

	private toDetails(torrent: RuntimeTorrent): TorrentDetails {
		return {
			downloaded: torrent.downloaded,
			downloadSpeed: torrent.downloadSpeed,
			files: torrent.files.map((file, index) =>
				fileDetails(torrent, file, index)
			),
			infoHash: torrent.infoHash,
			length: torrent.length,
			magnetUri: torrent.magnetURI,
			name: torrent.name,
			numPeers: torrent.numPeers,
			progress: torrent.progress,
			ready: torrent.ready,
		}
	}
}

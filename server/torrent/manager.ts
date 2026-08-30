import type { Dirent } from 'node:fs'
import { readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import WebTorrent, {
	type Torrent,
	type TorrentFile,
	type TorrentOptions,
} from 'webtorrent'
import type { TorrentRuntimeConfig } from '../config'
import type { AppDatabase, CacheEntry, TorrentSummary } from '../database'
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
	infoHash: string
	metadataReady: boolean
}

export interface TorrentServiceHealth {
	activeSessions: number
	destroyed: boolean
	preloadJobs: number
}

export type PreloadState = 'completed' | 'failed' | 'running'

export interface PreloadStatus {
	downloadedBytes: number
	error?: string
	finishedAt?: string
	infoHash: string
	startedAt: string
	state: PreloadState
	totalBytes: number
}

export interface OpenedTorrentFile {
	contentLength: number
	file: TorrentFileDetails
	range: ByteRange | null
	stream: ReadableStream<Uint8Array> | null
}

export interface TorrentManagerOptions {
	client?: WebTorrent
	config: TorrentRuntimeConfig
	database: AppDatabase
	logger: AppLogger
}

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

const normalizeFilePath = (path: string): string =>
	path.replaceAll('\\', '/').replace(LEADING_SLASH_PATTERN, '')

const displayPath = (torrent: Torrent, file: TorrentFile): string[] => {
	const parts = normalizeFilePath(file.path).split('/').filter(Boolean)
	if (parts.length > 1 && parts[0] === torrent.name) {
		return parts.slice(1)
	}
	return parts
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

const boundedStream = (
	source: ReadableStream<Uint8Array>,
	maximumBytes: number,
	onFinalize: () => void
): ReadableStream<Uint8Array> => {
	const reader = source.getReader()
	let remaining = maximumBytes
	let finalized = false
	const finalize = (): void => {
		if (finalized) {
			return
		}
		finalized = true
		onFinalize()
	}
	return new ReadableStream<Uint8Array>({
		async cancel(reason) {
			try {
				await reader.cancel(reason)
			} finally {
				finalize()
			}
		},
		async pull(controller) {
			try {
				const { done, value } = await reader.read()
				if (done || remaining === 0) {
					controller.close()
					await reader.cancel()
					finalize()
					return
				}
				const chunk =
					value.byteLength > remaining ? value.subarray(0, remaining) : value
				remaining -= chunk.byteLength
				controller.enqueue(chunk)
				if (remaining === 0) {
					controller.close()
					await reader.cancel()
					finalize()
				}
			} catch (error) {
				controller.error(error)
				finalize()
			}
		},
	})
}

export class TorrentManager {
	private readonly client: WebTorrent
	private readonly config: TorrentRuntimeConfig
	private readonly database: AppDatabase
	private readonly logger: AppLogger
	private readonly preloadJobs = new Map<string, PreloadStatus>()
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
	}

	async close(): Promise<void> {
		if (this.closing) {
			return
		}
		this.closing = true
		const sessions = [...this.sessions.values()]
		await Promise.all(
			sessions.map(async (session) => {
				if (session.idleTimer) {
					clearTimeout(session.idleTimer)
				}
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

	list(): TorrentSummary[] {
		return this.database.listTorrents()
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
			return {
				contentLength,
				file: fileDetails(torrent, file, index),
				range,
				stream: boundedStream(source, contentLength, () =>
					this.release(session)
				),
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

	register(source: string): TorrentRegistration {
		const reference = parseTorrentReference(source)
		const existing = this.sessions.get(reference.infoHash)
		const session = existing ?? this.createSession(reference)
		return {
			infoHash: reference.infoHash,
			metadataReady: session.torrent.files.length > 0,
		}
	}

	async remove(infoHash: string): Promise<boolean> {
		const normalized = normalizeInfoHash(infoHash)
		const session = this.sessions.get(normalized)
		if (session) {
			if (session.idleTimer) {
				clearTimeout(session.idleTimer)
			}
			await this.client.remove(session.torrent, { destroyStore: false })
			this.sessions.delete(normalized)
		}
		await rm(this.cachePath(normalized), { force: true, recursive: true })
		return this.database.deleteTorrent(normalized)
	}

	startPreload(infoHash: string): PreloadStatus {
		const normalized = normalizeInfoHash(infoHash)
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
		this.executePreload(status).catch((error: unknown) => {
			status.error = asError(error).message
			status.finishedAt = new Date().toISOString()
			status.state = 'failed'
			this.logger.error('Torrent preload failed', {
				error: status.error,
				infoHash: normalized,
			})
		})
		return status
	}

	private acquireByInfoHash(infoHash: string): TorrentSession {
		if (this.closing) {
			throw new HttpError(503, 'server_stopping', 'Torrent service is stopping')
		}
		const normalized = normalizeInfoHash(infoHash)
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
			this.saveCompletedState(session).catch((error: unknown) => {
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

	private async executePreload(status: PreloadStatus): Promise<void> {
		const session = this.acquireByInfoHash(status.infoHash)
		try {
			const torrent = await waitFor(
				session.ready,
				this.config.metadataTimeoutMs
			)
			status.totalBytes = torrent.length
			for (const file of torrent.files) {
				// biome-ignore lint/performance/noAwaitInLoops: Consume files sequentially to keep browser-server preload memory bounded.
				for await (const chunk of file) {
					status.downloadedBytes += chunk.byteLength
				}
			}
			status.downloadedBytes = torrent.length
			status.finishedAt = new Date().toISOString()
			status.state = 'completed'
			await this.saveCompletedState(session)
			const bytes = await this.measureCacheBytes(session.infoHash)
			this.database.recordCache(session.infoHash, bytes, true)
			await this.pruneCache()
		} finally {
			this.release(session)
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
			if (this.sessions.has(entry.infoHash)) {
				continue
			}
			victims.push(entry)
			total -= entry.bytes
		}
		await Promise.all(
			victims.map(async (entry) => {
				await rm(this.cachePath(entry.infoHash), {
					force: true,
					recursive: true,
				})
				this.database.removeCacheEntry(entry.infoHash)
				this.logger.info('Evicted torrent cache entry', {
					bytes: entry.bytes,
					infoHash: entry.infoHash,
				})
			})
		)
	}

	private release(session: TorrentSession): void {
		session.activeOperations = Math.max(0, session.activeOperations - 1)
		if (
			this.closing ||
			session.activeOperations > 0 ||
			this.sessions.get(session.infoHash) !== session
		) {
			return
		}
		if (session.idleTimer) {
			clearTimeout(session.idleTimer)
		}
		session.idleTimer = setTimeout(() => {
			this.dropIdleSession(session).catch((error: unknown) => {
				this.logger.error('Unable to drop idle torrent session', {
					error: asError(error).message,
					infoHash: session.infoHash,
				})
			})
		}, this.config.graceMs)
	}

	private async saveCompletedState(session: TorrentSession): Promise<void> {
		const fileModtimes = await new Promise<number[]>((resolve, reject) => {
			session.torrent.getFileModtimes((error, values) => {
				if (error) {
					reject(error)
					return
				}
				resolve(values ?? [])
			})
		})
		this.database.saveFileModtimes(session.infoHash, fileModtimes, true)
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

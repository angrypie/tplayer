import Dexie, { type DexieOptions, type Table, type Transaction } from 'dexie'

const DATABASE_NAME = 'books'
const CHUNKED_FILE_DATABASE_VERSION = 4
const CURRENT_DATABASE_VERSION = 7

export interface PlaybackState {
	path: string[]
	time: number
	updatedAt?: number
}

export type TorrentMetadata = Record<string, unknown>

export interface StoredTorrent {
	ih: string
	info: TorrentMetadata
	state: PlaybackState
}

interface StoredFileBase {
	ih: string
	length: number
	mimeType: string
	path: string
	validator?: string
}

export interface StoredBlobFile extends StoredFileBase {
	file: Blob
	storage: 'blob'
}

export interface StoredChunkedFile extends StoredFileBase {
	chunkSize: number
	file?: undefined
	storage: 'chunks'
}

export type StoredFile = StoredBlobFile | StoredChunkedFile

export interface StoredFileChunk {
	data: Blob
	end: number
	ih: string
	index: number
	path: string
	start: number
}

export interface StoredFileDownload {
	chunkSize: number
	downloadedBytes: number
	generation?: number
	ih: string
	length: number
	mimeType: string
	path: string
	updatedAt: number
	validator?: string
}

export interface StoredOfflineGeneration {
	generation: number
	ih: string
	removed?: boolean
	updatedAt: number
}

export interface StoredOfflineLease {
	expiresAt: number
	name: string
	owner: string
}

export interface OfflineFileState {
	complete: boolean
	downloadedBytes: number
	generation: number
	length: number
	mimeType: string
	path: string
	validator?: string
}

export interface FileChunkInput {
	chunkSize: number
	data: Blob
	end: number
	generation: number
	ih: string
	index: number
	length: number
	mimeType: string
	path: string
	start: number
	validator: string
}

export interface StalePartialCleanupOptions {
	cutoffUpdatedAt: number
	maxChunks?: number
	maxDownloads?: number
}

export interface StalePartialCleanupResult {
	deletedBytes: number
	deletedChunks: number
	deletedDownloads: number
	hasMore: boolean
}

export interface StoredNote {
	id?: number
	ih: string
	note: string
	path: string
	time: number
}

export interface StoredCaptionTrack {
	artifactUpdatedAt?: string
	bytes: ArrayBuffer
	cueCount: number
	durationMilliseconds?: number
	etag: string
	fileLength: number
	formatVersion: number
	ih: string
	language?: string
	path: string
	updatedAt: number
}

export interface TorrentUpdate {
	info?: TorrentMetadata
	state?: PlaybackState
}

export interface StorageOptions {
	databaseName?: string
	IDBKeyRange?: DexieOptions['IDBKeyRange']
	indexedDB?: DexieOptions['indexedDB']
}

interface LegacyTorrent {
	ih: string
	info: unknown
	state?: unknown
}

interface LegacyFile {
	file: Blob
	ih: string
	path: string
}

type StoredFileRecord = LegacyFile | StoredFile

interface MigratedLegacyFile extends LegacyFile {
	length: number
	mimeType: string
	storage: 'blob'
}

interface LegacyNote {
	id?: number
	ih: string
	note: string
	path: string
	time: number
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value)

const normalizeInfoHash = (infoHash: string): string =>
	infoHash.trim().toLowerCase()

const shouldReplaceCaptionTrack = (
	current: StoredCaptionTrack,
	candidate: StoredCaptionTrack
): boolean => {
	const currentRevision = current.artifactUpdatedAt
	const candidateRevision = candidate.artifactUpdatedAt
	if (currentRevision === undefined && candidateRevision === undefined) {
		return candidate.updatedAt >= current.updatedAt
	}
	if (candidateRevision === undefined) {
		return false
	}
	const candidateRevisionTime = Date.parse(candidateRevision)
	if (!Number.isFinite(candidateRevisionTime)) {
		return false
	}
	if (currentRevision === undefined) {
		return true
	}

	const currentRevisionTime = Date.parse(currentRevision)
	if (!Number.isFinite(currentRevisionTime)) {
		return false
	}
	if (candidateRevisionTime !== currentRevisionTime) {
		return candidateRevisionTime > currentRevisionTime
	}
	if (candidate.etag !== current.etag) {
		return false
	}
	return candidate.updatedAt >= current.updatedAt
}

const normalizeMetadata = (value: unknown): TorrentMetadata => {
	let parsed = value
	if (typeof value === 'string') {
		try {
			parsed = JSON.parse(value) as unknown
		} catch {
			return { legacyInfo: value }
		}
	}
	return isRecord(parsed) ? parsed : { legacyInfo: parsed }
}

const appendPathParts = (value: unknown, path: string[]): void => {
	if (Array.isArray(value)) {
		for (const entry of value) {
			appendPathParts(entry, path)
		}
		return
	}
	if (typeof value === 'string' && value.length > 0) {
		path.push(value)
	}
}

const normalizePath = (value: unknown): string[] => {
	const path: string[] = []
	appendPathParts(value, path)
	return path
}

const normalizePlaybackState = (value: unknown): PlaybackState => {
	if (!isRecord(value)) {
		return { path: [], time: 0 }
	}
	const path = normalizePath(value.path)
	const time =
		typeof value.time === 'number' && Number.isFinite(value.time)
			? value.time
			: 0
	const updatedAt =
		typeof value.updatedAt === 'number' && Number.isFinite(value.updatedAt)
			? value.updatedAt
			: undefined
	return updatedAt === undefined ? { path, time } : { path, time, updatedAt }
}

const mergeTorrentRecords = (
	current: StoredTorrent | undefined,
	candidate: StoredTorrent
): StoredTorrent => {
	if (!current) {
		return candidate
	}
	const currentUpdatedAt = current.state.updatedAt ?? 0
	const candidateUpdatedAt = candidate.state.updatedAt ?? 0
	return candidateUpdatedAt > currentUpdatedAt ? candidate : current
}

const migrateVersionTwo = async (transaction: Transaction): Promise<void> => {
	const torrentTable = transaction.table<LegacyTorrent, string>('torrents')
	const fileTable = transaction.table<LegacyFile, [string, string]>('files')
	const noteTable = transaction.table<LegacyNote, number>('notes')
	const [legacyTorrents, legacyFiles, legacyNotes] = await Promise.all([
		torrentTable.toArray(),
		fileTable.toArray(),
		noteTable.toArray(),
	])

	const torrentsByHash = new Map<string, StoredTorrent>()
	for (const record of legacyTorrents) {
		const ih = normalizeInfoHash(record.ih)
		const candidate: StoredTorrent = {
			ih,
			info: normalizeMetadata(record.info),
			state: normalizePlaybackState(record.state),
		}
		torrentsByHash.set(
			ih,
			mergeTorrentRecords(torrentsByHash.get(ih), candidate)
		)
	}

	const filesByKey = new Map<string, MigratedLegacyFile>()
	for (const record of legacyFiles) {
		const ih = normalizeInfoHash(record.ih)
		const key = `${ih}\0${record.path}`
		if (!filesByKey.has(key)) {
			filesByKey.set(key, {
				file: record.file,
				ih,
				length: record.file.size,
				mimeType: record.file.type,
				path: record.path,
				storage: 'blob',
			})
		}
	}

	const notes = legacyNotes.map((record) => ({
		...record,
		ih: normalizeInfoHash(record.ih),
	}))

	await Promise.all([
		torrentTable.clear(),
		fileTable.clear(),
		noteTable.clear(),
	])
	const torrents = [...torrentsByHash.values()]
	const files = [...filesByKey.values()]
	if (torrents.length > 0) {
		await torrentTable.bulkPut(torrents)
	}
	if (files.length > 0) {
		await fileTable.bulkPut(files)
	}
	if (notes.length > 0) {
		await noteTable.bulkPut(notes)
	}
}

const toDexieOptions = ({
	IDBKeyRange,
	indexedDB,
}: StorageOptions): DexieOptions => ({
	...(indexedDB ? { indexedDB } : {}),
	...(IDBKeyRange ? { IDBKeyRange } : {}),
})

class BooksDatabase extends Dexie {
	captions!: Table<StoredCaptionTrack, [string, string]>
	fileChunks!: Table<StoredFileChunk, [string, string, number]>
	fileDownloads!: Table<StoredFileDownload, [string, string]>
	files!: Table<StoredFileRecord, [string, string]>
	notes!: Table<StoredNote, number>
	offlineGenerations!: Table<StoredOfflineGeneration, string>
	offlineLeases!: Table<StoredOfflineLease, string>
	torrents!: Table<StoredTorrent, string>

	constructor(options: StorageOptions) {
		super(options.databaseName ?? DATABASE_NAME, toDexieOptions(options))
		this.version(2).stores({
			files: '[ih+path]',
			notes: '++id, ih',
			torrents: 'ih',
		})
		this.version(3)
			.stores({
				files: '[ih+path], ih',
				notes: '++id, ih, [ih+path]',
				torrents: 'ih, state.updatedAt',
			})
			.upgrade(migrateVersionTwo)
		this.version(CHUNKED_FILE_DATABASE_VERSION).stores({
			fileChunks: '[ih+path+index], [ih+path], ih',
			fileDownloads: '[ih+path], ih, updatedAt',
			files: '[ih+path], ih',
			notes: '++id, ih, [ih+path]',
			torrents: 'ih, state.updatedAt',
		})
		this.version(CURRENT_DATABASE_VERSION).stores({
			captions: '[ih+path], ih, updatedAt',
			fileChunks: '[ih+path+index], [ih+path], ih',
			fileDownloads: '[ih+path], ih, updatedAt',
			files: '[ih+path], ih',
			notes: '++id, ih, [ih+path]',
			offlineGenerations: 'ih, updatedAt',
			offlineLeases: 'name, expiresAt',
			torrents: 'ih, state.updatedAt',
		})
	}
}

const expectedChunkLength = (
	index: number,
	length: number,
	chunkSize: number
): number => Math.min(chunkSize, Math.max(0, length - index * chunkSize))

const isLegacyBlobFile = (file: StoredFileRecord): file is LegacyFile =>
	!('storage' in file) && file.file instanceof Blob

const normalizeStoredFile = (file: StoredFileRecord): StoredFile =>
	isLegacyBlobFile(file)
		? {
				...file,
				length: file.file.size,
				mimeType: file.file.type,
				storage: 'blob',
			}
		: file

const storedFileLength = (file: StoredFileRecord): number =>
	isLegacyBlobFile(file) ? file.file.size : file.length

const storedFileMimeType = (file: StoredFileRecord): string =>
	isLegacyBlobFile(file) ? file.file.type : file.mimeType

const offlineStateFromFile = (file: StoredFileRecord): OfflineFileState => {
	const length = storedFileLength(file)
	return {
		complete: true,
		downloadedBytes: length,
		generation: 0,
		length,
		mimeType: storedFileMimeType(file),
		path: file.path,
		...(!isLegacyBlobFile(file) && file.validator
			? { validator: file.validator }
			: {}),
	}
}

const offlineStateFromDownload = (
	download: StoredFileDownload
): OfflineFileState => ({
	complete: false,
	downloadedBytes: download.downloadedBytes,
	generation: download.generation ?? 0,
	length: download.length,
	mimeType: download.mimeType,
	path: download.path,
	...(download.validator ? { validator: download.validator } : {}),
})

const generationValue = (record: StoredOfflineGeneration | undefined): number =>
	record?.generation ?? 0

const invalidatedDownloadError = (): DOMException =>
	new DOMException('Offline cache operation was invalidated', 'AbortError')

const rotateOfflineGeneration = async (
	table: Table<StoredOfflineGeneration, string>,
	ih: string,
	removed = false
): Promise<number> => {
	const generation = generationValue(await table.get(ih)) + 1
	await table.put({ generation, ih, removed, updatedAt: Date.now() })
	return generation
}

const assertOfflineGeneration = async (
	table: Table<StoredOfflineGeneration, string>,
	ih: string,
	expectedGeneration: number
): Promise<void> => {
	const record = await table.get(ih)
	if (record?.removed || generationValue(record) !== expectedGeneration) {
		throw invalidatedDownloadError()
	}
}

export class BookStorage {
	private readonly database: BooksDatabase

	constructor(options: StorageOptions = {}) {
		this.database = new BooksDatabase(options)
	}

	async addTorrent(ih: string, info: unknown): Promise<void> {
		const normalizedHash = normalizeInfoHash(ih)
		await this.database.transaction(
			'rw',
			[this.database.offlineGenerations, this.database.torrents],
			async () => {
				const [current, generation] = await Promise.all([
					this.database.torrents.get(normalizedHash),
					this.database.offlineGenerations.get(normalizedHash),
				])
				if (generation?.removed) {
					await rotateOfflineGeneration(
						this.database.offlineGenerations,
						normalizedHash
					)
				}
				await this.database.torrents.put({
					ih: normalizedHash,
					info: normalizeMetadata(info),
					state: current?.state ?? { path: [], time: 0 },
				})
			}
		)
	}

	async getTorrent(ih: string): Promise<StoredTorrent | null> {
		return (await this.database.torrents.get(normalizeInfoHash(ih))) ?? null
	}

	async putCaptionTrack(track: StoredCaptionTrack): Promise<void> {
		const normalizedHash = normalizeInfoHash(track.ih)
		await this.database.transaction(
			'rw',
			[
				this.database.captions,
				this.database.offlineGenerations,
				this.database.torrents,
			],
			async () => {
				const [current, generation, torrent] = await Promise.all([
					this.database.captions.get([normalizedHash, track.path]),
					this.database.offlineGenerations.get(normalizedHash),
					this.database.torrents.get(normalizedHash),
				])
				if (generation?.removed || !torrent) {
					throw invalidatedDownloadError()
				}
				if (current && !shouldReplaceCaptionTrack(current, track)) {
					return
				}
				await this.database.captions.put({
					...track,
					bytes: track.bytes.slice(0),
					ih: normalizedHash,
				})
			}
		)
	}

	async getCaptionTrack(
		ih: string,
		path: string
	): Promise<StoredCaptionTrack | null> {
		return (
			(await this.database.captions.get([normalizeInfoHash(ih), path])) ?? null
		)
	}

	async getCaptionTracksForTorrent(ih: string): Promise<StoredCaptionTrack[]> {
		return await this.database.captions
			.where('ih')
			.equals(normalizeInfoHash(ih))
			.toArray()
	}

	async removeCaptionTrack(
		ih: string,
		path: string,
		expected?: Pick<
			StoredCaptionTrack,
			'artifactUpdatedAt' | 'etag' | 'updatedAt'
		>
	): Promise<boolean> {
		return await this.database.transaction(
			'rw',
			this.database.captions,
			async () => {
				const key: [string, string] = [normalizeInfoHash(ih), path]
				const current = await this.database.captions.get(key)
				if (!current) {
					return false
				}
				if (
					expected &&
					(current.artifactUpdatedAt !== expected.artifactUpdatedAt ||
						current.etag !== expected.etag ||
						current.updatedAt !== expected.updatedAt)
				) {
					return false
				}
				await this.database.captions.delete(key)
				return true
			}
		)
	}

	async removeCaptionTracksByIh(ih: string): Promise<number> {
		return await this.database.captions
			.where('ih')
			.equals(normalizeInfoHash(ih))
			.delete()
	}

	async tryAcquireOfflineLease(
		name: string,
		owner: string,
		now: number,
		expiresAt: number
	): Promise<boolean> {
		return await this.database.transaction(
			'rw',
			this.database.offlineLeases,
			async () => {
				const current = await this.database.offlineLeases.get(name)
				if (current && current.owner !== owner && current.expiresAt > now) {
					return false
				}
				await this.database.offlineLeases.put({ expiresAt, name, owner })
				return true
			}
		)
	}

	async renewOfflineLease(
		name: string,
		owner: string,
		expiresAt: number
	): Promise<boolean> {
		return await this.database.transaction(
			'rw',
			this.database.offlineLeases,
			async () => {
				const current = await this.database.offlineLeases.get(name)
				if (current?.owner !== owner) {
					return false
				}
				await this.database.offlineLeases.put({ expiresAt, name, owner })
				return true
			}
		)
	}

	async releaseOfflineLease(name: string, owner: string): Promise<void> {
		await this.database.transaction(
			'rw',
			this.database.offlineLeases,
			async () => {
				const current = await this.database.offlineLeases.get(name)
				if (current?.owner === owner) {
					await this.database.offlineLeases.delete(name)
				}
			}
		)
	}

	async getTorrents(limit?: number): Promise<StoredTorrent[]> {
		const torrents = await this.database.torrents.toArray()
		torrents.sort((left, right) => {
			const updatedDifference =
				(right.state.updatedAt ?? 0) - (left.state.updatedAt ?? 0)
			return updatedDifference || left.ih.localeCompare(right.ih)
		})
		if (limit === undefined) {
			return torrents
		}
		return torrents.slice(0, Math.max(0, Math.trunc(limit)))
	}

	async addFile(ih: string, path: string, file: Blob): Promise<void> {
		const normalizedHash = normalizeInfoHash(ih)
		await this.database.transaction(
			'rw',
			[
				this.database.fileChunks,
				this.database.fileDownloads,
				this.database.files,
			],
			async () => {
				await Promise.all([
					this.database.fileChunks
						.where('[ih+path]')
						.equals([normalizedHash, path])
						.delete(),
					this.database.fileDownloads.delete([normalizedHash, path]),
				])
				await this.database.files.put({
					file,
					ih: normalizedHash,
					length: file.size,
					mimeType: file.type,
					path,
					storage: 'blob',
				})
			}
		)
	}

	async getFile(ih: string, path: string): Promise<StoredFile | null> {
		const file = await this.database.files.get([normalizeInfoHash(ih), path])
		return file ? normalizeStoredFile(file) : null
	}

	async getFileBlob(ih: string, path: string): Promise<Blob | null> {
		const normalizedHash = normalizeInfoHash(ih)
		return await this.database.transaction(
			'r',
			[this.database.fileChunks, this.database.files],
			async () => {
				const file = await this.database.files.get([normalizedHash, path])
				if (!file) {
					return null
				}
				const normalizedFile = normalizeStoredFile(file)
				if (normalizedFile.storage === 'blob') {
					return normalizedFile.file
				}
				const chunks = await this.database.fileChunks
					.where('[ih+path]')
					.equals([normalizedHash, path])
					.sortBy('index')
				const hasEveryByte =
					chunks.length ===
						Math.ceil(normalizedFile.length / normalizedFile.chunkSize) &&
					chunks.every((chunk, index) => {
						const chunkLength = expectedChunkLength(
							index,
							normalizedFile.length,
							normalizedFile.chunkSize
						)
						return (
							chunk.index === index &&
							chunk.start === index * normalizedFile.chunkSize &&
							chunk.end === chunk.start + chunkLength - 1 &&
							chunk.data.size === chunkLength
						)
					})
				if (!hasEveryByte) {
					return null
				}
				return new Blob(
					chunks.map((chunk) => chunk.data),
					{ type: storedFileMimeType(normalizedFile) }
				)
			}
		)
	}

	async getOfflineFileState(
		ih: string,
		path: string
	): Promise<OfflineFileState | null> {
		const normalizedHash = normalizeInfoHash(ih)
		const [file, download] = await Promise.all([
			this.database.files.get([normalizedHash, path]),
			this.database.fileDownloads.get([normalizedHash, path]),
		])
		if (file) {
			return offlineStateFromFile(file)
		}
		return download ? offlineStateFromDownload(download) : null
	}

	async getOfflineGeneration(ih: string): Promise<number> {
		const record = await this.database.offlineGenerations.get(
			normalizeInfoHash(ih)
		)
		if (record?.removed) {
			throw invalidatedDownloadError()
		}
		return generationValue(record)
	}

	async getOfflineFileStatesForTorrent(
		ih: string
	): Promise<OfflineFileState[]> {
		const normalizedHash = normalizeInfoHash(ih)
		const [files, downloads] = await Promise.all([
			this.database.files.where('ih').equals(normalizedHash).toArray(),
			this.database.fileDownloads.where('ih').equals(normalizedHash).toArray(),
		])
		const states = new Map<string, OfflineFileState>()
		for (const download of downloads) {
			states.set(download.path, offlineStateFromDownload(download))
		}
		for (const file of files) {
			states.set(file.path, offlineStateFromFile(file))
		}
		return [...states.values()]
	}

	async prepareFileDownload(
		ih: string,
		path: string,
		length: number,
		mimeType: string,
		chunkSize: number,
		generation = 0
	): Promise<OfflineFileState> {
		const normalizedHash = normalizeInfoHash(ih)
		return await this.database.transaction(
			'rw',
			[
				this.database.fileChunks,
				this.database.fileDownloads,
				this.database.files,
				this.database.offlineGenerations,
			],
			async () => {
				await assertOfflineGeneration(
					this.database.offlineGenerations,
					normalizedHash,
					generation
				)
				const complete = await this.database.files.get([normalizedHash, path])
				if (complete) {
					return { ...offlineStateFromFile(complete), generation }
				}

				const existing = await this.database.fileDownloads.get([
					normalizedHash,
					path,
				])
				const isCompatible =
					existing?.length === length && existing.chunkSize === chunkSize
				if (!isCompatible) {
					await this.database.fileChunks
						.where('[ih+path]')
						.equals([normalizedHash, path])
						.delete()
				}

				const chunks = isCompatible
					? await this.database.fileChunks
							.where('[ih+path]')
							.equals([normalizedHash, path])
							.toArray()
					: []
				let downloadedBytes = 0
				const invalidChunkKeys: [string, string, number][] = []
				for (const chunk of chunks) {
					const expectedLength = expectedChunkLength(
						chunk.index,
						length,
						chunkSize
					)
					const isValid =
						expectedLength > 0 &&
						chunk.start === chunk.index * chunkSize &&
						chunk.end === chunk.start + expectedLength - 1 &&
						chunk.data.size === expectedLength
					if (isValid) {
						downloadedBytes += expectedLength
					} else {
						invalidChunkKeys.push([normalizedHash, path, chunk.index])
					}
				}
				await this.database.fileChunks.bulkDelete(invalidChunkKeys)

				const download: StoredFileDownload = {
					chunkSize,
					downloadedBytes,
					generation,
					ih: normalizedHash,
					length,
					mimeType,
					path,
					updatedAt: Date.now(),
					...(isCompatible && existing.validator
						? { validator: existing.validator }
						: {}),
				}
				await this.database.fileDownloads.put(download)
				return offlineStateFromDownload(download)
			}
		)
	}

	async restartFileDownload(
		ih: string,
		path: string,
		length: number,
		mimeType: string,
		chunkSize: number,
		generation: number,
		validator?: string
	): Promise<OfflineFileState> {
		const normalizedHash = normalizeInfoHash(ih)
		return await this.database.transaction(
			'rw',
			[
				this.database.fileChunks,
				this.database.fileDownloads,
				this.database.files,
				this.database.offlineGenerations,
			],
			async () => {
				await assertOfflineGeneration(
					this.database.offlineGenerations,
					normalizedHash,
					generation
				)
				const complete = await this.database.files.get([normalizedHash, path])
				if (complete) {
					return { ...offlineStateFromFile(complete), generation }
				}
				await this.database.fileChunks
					.where('[ih+path]')
					.equals([normalizedHash, path])
					.delete()
				const download: StoredFileDownload = {
					chunkSize,
					downloadedBytes: 0,
					generation,
					ih: normalizedHash,
					length,
					mimeType,
					path,
					updatedAt: Date.now(),
					...(validator ? { validator } : {}),
				}
				await this.database.fileDownloads.put(download)
				return offlineStateFromDownload(download)
			}
		)
	}

	async getStoredFileChunkIndexes(
		ih: string,
		path: string
	): Promise<Set<number>> {
		const chunks = await this.database.fileChunks
			.where('[ih+path]')
			.equals([normalizeInfoHash(ih), path])
			.toArray()
		return new Set(chunks.map((chunk) => chunk.index))
	}

	async cleanupStalePartialDownloads({
		cutoffUpdatedAt,
		maxChunks = 64,
		maxDownloads = 8,
	}: StalePartialCleanupOptions): Promise<StalePartialCleanupResult> {
		const boundedChunkCount = Math.max(1, Math.trunc(maxChunks))
		const boundedDownloadCount = Math.max(1, Math.trunc(maxDownloads))
		return await this.database.transaction(
			'rw',
			[
				this.database.fileChunks,
				this.database.fileDownloads,
				this.database.files,
			],
			async () => {
				const candidates = await this.database.fileDownloads
					.where('updatedAt')
					.belowOrEqual(cutoffUpdatedAt)
					.limit(boundedDownloadCount)
					.toArray()
				let deletedBytes = 0
				let deletedChunks = 0
				let deletedDownloads = 0
				for (const candidate of candidates) {
					if (deletedChunks >= boundedChunkCount) {
						break
					}
					// biome-ignore lint/performance/noAwaitInLoops: Each stale manifest is rechecked inside one bounded transaction.
					const current = await this.database.fileDownloads.get([
						candidate.ih,
						candidate.path,
					])
					if (!current || current.updatedAt > cutoffUpdatedAt) {
						continue
					}
					const complete = await this.database.files.get([
						candidate.ih,
						candidate.path,
					])
					if (complete) {
						await this.database.fileDownloads.delete([
							candidate.ih,
							candidate.path,
						])
						deletedDownloads += 1
						continue
					}
					const remainingChunkBudget = boundedChunkCount - deletedChunks
					const chunks = await this.database.fileChunks
						.where('[ih+path]')
						.equals([candidate.ih, candidate.path])
						.limit(remainingChunkBudget)
						.toArray()
					if (chunks.length > 0) {
						await this.database.fileChunks.bulkDelete(
							chunks.map((chunk) => [chunk.ih, chunk.path, chunk.index])
						)
					}
					const removedBytes = chunks.reduce(
						(total, chunk) => total + chunk.data.size,
						0
					)
					deletedBytes += removedBytes
					deletedChunks += chunks.length
					const remainingChunks = await this.database.fileChunks
						.where('[ih+path]')
						.equals([candidate.ih, candidate.path])
						.count()
					if (remainingChunks === 0) {
						await this.database.fileDownloads.delete([
							candidate.ih,
							candidate.path,
						])
						deletedDownloads += 1
					} else {
						await this.database.fileDownloads.put({
							...current,
							downloadedBytes: Math.max(
								0,
								current.downloadedBytes - removedBytes
							),
						})
					}
				}
				const hasMore =
					(await this.database.fileDownloads
						.where('updatedAt')
						.belowOrEqual(cutoffUpdatedAt)
						.count()) > 0
				return {
					deletedBytes,
					deletedChunks,
					deletedDownloads,
					hasMore,
				}
			}
		)
	}

	async putFileChunk(input: FileChunkInput): Promise<OfflineFileState> {
		const normalizedHash = normalizeInfoHash(input.ih)
		const expectedLength = expectedChunkLength(
			input.index,
			input.length,
			input.chunkSize
		)
		const expectedStart = input.index * input.chunkSize
		if (
			expectedLength <= 0 ||
			input.start !== expectedStart ||
			input.end !== expectedStart + expectedLength - 1 ||
			input.data.size !== expectedLength
		) {
			throw new Error(
				'Offline file chunk does not match its expected byte range'
			)
		}

		return await this.database.transaction(
			'rw',
			[
				this.database.fileChunks,
				this.database.fileDownloads,
				this.database.offlineGenerations,
			],
			async () => {
				await assertOfflineGeneration(
					this.database.offlineGenerations,
					normalizedHash,
					input.generation
				)
				const key: [string, string, number] = [
					normalizedHash,
					input.path,
					input.index,
				]
				const [existingChunk, download] = await Promise.all([
					this.database.fileChunks.get(key),
					this.database.fileDownloads.get([normalizedHash, input.path]),
				])
				if (
					!download ||
					(download.generation ?? 0) !== input.generation ||
					download.length !== input.length ||
					download.chunkSize !== input.chunkSize
				) {
					throw new Error('Offline file download metadata changed')
				}
				if (download.validator && download.validator !== input.validator) {
					throw new Error('Offline file validator changed')
				}
				await this.database.fileChunks.put({
					data: input.data,
					end: input.end,
					ih: normalizedHash,
					index: input.index,
					path: input.path,
					start: input.start,
				})
				const downloadedBytes = Math.min(
					download.length,
					download.downloadedBytes +
						input.data.size -
						(existingChunk?.data.size ?? 0)
				)
				const updated = {
					...download,
					downloadedBytes,
					mimeType: input.mimeType || download.mimeType,
					updatedAt: Date.now(),
					validator: download.validator ?? input.validator,
				}
				await this.database.fileDownloads.put(updated)
				return offlineStateFromDownload(updated)
			}
		)
	}

	async completeFileDownload(
		ih: string,
		path: string,
		generation = 0
	): Promise<OfflineFileState> {
		const normalizedHash = normalizeInfoHash(ih)
		return await this.database.transaction(
			'rw',
			[
				this.database.fileChunks,
				this.database.fileDownloads,
				this.database.files,
				this.database.offlineGenerations,
			],
			async () => {
				await assertOfflineGeneration(
					this.database.offlineGenerations,
					normalizedHash,
					generation
				)
				const complete = await this.database.files.get([normalizedHash, path])
				if (complete) {
					return { ...offlineStateFromFile(complete), generation }
				}
				const download = await this.database.fileDownloads.get([
					normalizedHash,
					path,
				])
				if (!download) {
					throw new Error('Offline file download metadata is missing')
				}
				if ((download.generation ?? 0) !== generation) {
					throw invalidatedDownloadError()
				}
				const chunks = await this.database.fileChunks
					.where('[ih+path]')
					.equals([normalizedHash, path])
					.sortBy('index')
				const expectedCount = Math.ceil(download.length / download.chunkSize)
				const isComplete =
					chunks.length === expectedCount &&
					chunks.every((chunk, index) => {
						const expectedLength = expectedChunkLength(
							index,
							download.length,
							download.chunkSize
						)
						return (
							chunk.index === index &&
							chunk.start === index * download.chunkSize &&
							chunk.end === chunk.start + expectedLength - 1 &&
							chunk.data.size === expectedLength
						)
					})
				if (!isComplete) {
					throw new Error('Offline file is missing one or more byte ranges')
				}
				const file: StoredChunkedFile = {
					chunkSize: download.chunkSize,
					ih: normalizedHash,
					length: download.length,
					mimeType: download.mimeType,
					path,
					storage: 'chunks',
					...(download.validator ? { validator: download.validator } : {}),
				}
				await this.database.files.put(file)
				await this.database.fileDownloads.delete([normalizedHash, path])
				return offlineStateFromFile(file)
			}
		)
	}

	async getAllFilesForTorrent(ih: string): Promise<StoredFile[]> {
		const files = await this.database.files
			.where('ih')
			.equals(normalizeInfoHash(ih))
			.toArray()
		return files.map(normalizeStoredFile)
	}

	async removeFile(ih: string, path: string): Promise<boolean> {
		const normalizedHash = normalizeInfoHash(ih)
		try {
			await this.database.transaction(
				'rw',
				[
					this.database.fileChunks,
					this.database.fileDownloads,
					this.database.files,
					this.database.offlineGenerations,
				],
				async () => {
					await rotateOfflineGeneration(
						this.database.offlineGenerations,
						normalizedHash
					)
					await Promise.all([
						this.database.fileChunks
							.where('[ih+path]')
							.equals([normalizedHash, path])
							.delete(),
						this.database.fileDownloads.delete([normalizedHash, path]),
						this.database.files.delete([normalizedHash, path]),
					])
				}
			)
			return true
		} catch {
			return false
		}
	}

	async removeFilesByIh(ih: string): Promise<boolean> {
		const normalizedHash = normalizeInfoHash(ih)
		try {
			await this.database.transaction(
				'rw',
				[
					this.database.fileChunks,
					this.database.fileDownloads,
					this.database.files,
					this.database.offlineGenerations,
				],
				async () => {
					await rotateOfflineGeneration(
						this.database.offlineGenerations,
						normalizedHash
					)
					await Promise.all([
						this.database.fileChunks
							.where('ih')
							.equals(normalizedHash)
							.delete(),
						this.database.fileDownloads
							.where('ih')
							.equals(normalizedHash)
							.delete(),
						this.database.files.where('ih').equals(normalizedHash).delete(),
					])
				}
			)
			return true
		} catch {
			return false
		}
	}

	async removeFilesAndTorrent(ih: string): Promise<boolean> {
		const normalizedHash = normalizeInfoHash(ih)
		try {
			await this.database.transaction(
				'rw',
				[
					this.database.captions,
					this.database.fileChunks,
					this.database.fileDownloads,
					this.database.files,
					this.database.notes,
					this.database.offlineGenerations,
					this.database.torrents,
				],
				async () => {
					await rotateOfflineGeneration(
						this.database.offlineGenerations,
						normalizedHash,
						true
					)
					await Promise.all([
						this.database.captions.where('ih').equals(normalizedHash).delete(),
						this.database.fileChunks
							.where('ih')
							.equals(normalizedHash)
							.delete(),
						this.database.fileDownloads
							.where('ih')
							.equals(normalizedHash)
							.delete(),
						this.database.files.where('ih').equals(normalizedHash).delete(),
						this.database.notes.where('ih').equals(normalizedHash).delete(),
						this.database.torrents.delete(normalizedHash),
					])
				}
			)
			return true
		} catch {
			return false
		}
	}

	async updateTorrent(ih: string, data: TorrentUpdate): Promise<number> {
		const update: TorrentUpdate = {
			...(data.info ? { info: normalizeMetadata(data.info) } : {}),
			...(data.state ? { state: normalizePlaybackState(data.state) } : {}),
		}
		const normalizedHash = normalizeInfoHash(ih)
		return await this.database.transaction(
			'rw',
			this.database.torrents,
			async () => {
				const current = await this.database.torrents.get(normalizedHash)
				if (!current) {
					return 0
				}
				await this.database.torrents.put({ ...current, ...update })
				return 1
			}
		)
	}

	async addNote(
		ih: string,
		path: string,
		time: number,
		note: string
	): Promise<number> {
		return await this.database.notes.add({
			ih: normalizeInfoHash(ih),
			note,
			path,
			time,
		})
	}

	async getNote(id: number): Promise<StoredNote | undefined> {
		return await this.database.notes.get(id)
	}

	async getAllNotes(ih: string): Promise<StoredNote[]> {
		const notes = await this.database.notes
			.where('ih')
			.equals(normalizeInfoHash(ih))
			.toArray()
		notes.sort((left, right) => (left.id ?? 0) - (right.id ?? 0))
		return notes
	}

	async removeNote(id: number): Promise<void> {
		await this.database.notes.delete(id)
	}

	close(): void {
		this.database.close()
	}

	async deleteDatabase(): Promise<void> {
		await this.database.delete()
	}
}

export const createStorage = (options: StorageOptions = {}): BookStorage =>
	new BookStorage(options)

export const storage = createStorage()

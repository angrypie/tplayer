import Dexie, { type DexieOptions, type Table, type Transaction } from 'dexie'

const DATABASE_NAME = 'books'
const CURRENT_DATABASE_VERSION = 3

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

export interface StoredFile {
	file: Blob
	ih: string
	path: string
}

export interface StoredNote {
	id?: number
	ih: string
	note: string
	path: string
	time: number
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

	const filesByKey = new Map<string, StoredFile>()
	for (const record of legacyFiles) {
		const ih = normalizeInfoHash(record.ih)
		const key = `${ih}\0${record.path}`
		if (!filesByKey.has(key)) {
			filesByKey.set(key, {
				file: record.file,
				ih,
				path: record.path,
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
	files!: Table<StoredFile, [string, string]>
	notes!: Table<StoredNote, number>
	torrents!: Table<StoredTorrent, string>

	constructor(options: StorageOptions) {
		super(options.databaseName ?? DATABASE_NAME, toDexieOptions(options))
		this.version(2).stores({
			files: '[ih+path]',
			notes: '++id, ih',
			torrents: 'ih',
		})
		this.version(CURRENT_DATABASE_VERSION)
			.stores({
				files: '[ih+path], ih',
				notes: '++id, ih, [ih+path]',
				torrents: 'ih, state.updatedAt',
			})
			.upgrade(migrateVersionTwo)
	}
}

export class BookStorage {
	private readonly database: BooksDatabase

	constructor(options: StorageOptions = {}) {
		this.database = new BooksDatabase(options)
	}

	async addTorrent(ih: string, info: unknown): Promise<void> {
		const normalizedHash = normalizeInfoHash(ih)
		await this.database.transaction('rw', this.database.torrents, async () => {
			const current = await this.database.torrents.get(normalizedHash)
			await this.database.torrents.put({
				ih: normalizedHash,
				info: normalizeMetadata(info),
				state: current?.state ?? { path: [], time: 0 },
			})
		})
	}

	async getTorrent(ih: string): Promise<StoredTorrent | null> {
		return (await this.database.torrents.get(normalizeInfoHash(ih))) ?? null
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
		await this.database.files.put({
			file,
			ih: normalizeInfoHash(ih),
			path,
		})
	}

	async getFile(ih: string, path: string): Promise<StoredFile | null> {
		return (
			(await this.database.files.get([normalizeInfoHash(ih), path])) ?? null
		)
	}

	async getAllFilesForTorrent(ih: string): Promise<StoredFile[]> {
		return await this.database.files
			.where('ih')
			.equals(normalizeInfoHash(ih))
			.toArray()
	}

	async removeFile(ih: string, path: string): Promise<boolean> {
		try {
			await this.database.files.delete([normalizeInfoHash(ih), path])
			return true
		} catch {
			return false
		}
	}

	async removeFilesByIh(ih: string): Promise<boolean> {
		try {
			await this.database.transaction('rw', this.database.files, async () => {
				await this.database.files
					.where('ih')
					.equals(normalizeInfoHash(ih))
					.delete()
			})
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
				[this.database.files, this.database.notes, this.database.torrents],
				async () => {
					await Promise.all([
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

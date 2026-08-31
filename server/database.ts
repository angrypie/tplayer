import { Database } from 'bun:sqlite'

export interface TorrentSummary {
	cachedBytes: number
	firstSeen: string
	infoHash: string
	lastSeen: string
	name: string
}

export interface TorrentStatusSummary extends TorrentSummary {
	cacheCompleted: boolean
	metadataCompleted: boolean
	metadataReady: boolean
}

export interface TorrentRegistrationRecord {
	backgroundDownload: boolean
	infoHash: string
	torrentId: string
}

export interface StoredTorrentMetadata {
	completed: boolean
	fileModtimes: number[] | null
	infoHash: string
	magnetUri: string
	torrentFile: Uint8Array
}

export interface CacheEntry {
	bytes: number
	completed: boolean
	infoHash: string
	lastAccessed: string
}

interface TorrentSummaryRow {
	cached_bytes: number | null
	first_seen: string
	info_hash: string
	last_seen: string
	name: string
}

interface TorrentStatusSummaryRow extends TorrentSummaryRow {
	cache_completed: number
	metadata_completed: number
	metadata_ready: number
}

interface MetadataRow {
	completed: number
	file_modtimes: string | null
	info_hash: string
	magnet_uri: string
	torrent_file: Uint8Array
}

interface CacheEntryRow {
	bytes: number
	completed: number
	info_hash: string
	last_accessed: string
}

interface TorrentRegistrationRow {
	background_download: number
	info_hash: string
	torrent_id: string
}

const nowExpression = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')"

const normalizeTimestamp = (value: string): string => {
	const parsed = new Date(value)
	if (!Number.isNaN(parsed.getTime())) {
		return parsed.toISOString()
	}
	const sqliteTimestamp = new Date(`${value.replace(' ', 'T')}Z`)
	return Number.isNaN(sqliteTimestamp.getTime())
		? value
		: sqliteTimestamp.toISOString()
}

export class AppDatabase {
	readonly connection: Database

	constructor(path: string) {
		this.connection = new Database(path, { create: true, strict: true })
		this.connection.exec('PRAGMA journal_mode = WAL')
		this.connection.exec('PRAGMA foreign_keys = ON')
		this.connection.exec('PRAGMA synchronous = NORMAL')
		this.connection.exec('PRAGMA busy_timeout = 5000')
		this.migrate()
	}

	close(): void {
		this.connection.exec('PRAGMA wal_checkpoint(TRUNCATE)')
		this.connection.close()
	}

	deleteTorrent(infoHash: string): boolean {
		const result = this.connection
			.query('DELETE FROM torrent_history WHERE info_hash = ?')
			.run(infoHash)
		return result.changes > 0
	}

	getMetadata(infoHash: string): StoredTorrentMetadata | null {
		const row = this.connection
			.query<MetadataRow, [string]>(
				`SELECT info_hash, torrent_file, magnet_uri, file_modtimes, completed
				 FROM torrent_metadata
				 WHERE info_hash = ?`
			)
			.get(infoHash)
		if (!row) {
			return null
		}
		return {
			completed: row.completed === 1,
			fileModtimes: row.file_modtimes
				? (JSON.parse(row.file_modtimes) as number[])
				: null,
			infoHash: row.info_hash,
			magnetUri: row.magnet_uri,
			torrentFile: new Uint8Array(row.torrent_file),
		}
	}

	getCacheEntry(infoHash: string): CacheEntry | null {
		const row = this.connection
			.query<CacheEntryRow, [string]>(
				`SELECT info_hash, bytes, completed, last_accessed
				 FROM torrent_cache
				 WHERE info_hash = ?`
			)
			.get(infoHash)
		if (!row) {
			return null
		}
		return {
			bytes: row.bytes,
			completed: row.completed === 1,
			infoHash: row.info_hash,
			lastAccessed: normalizeTimestamp(row.last_accessed),
		}
	}

	getTorrentSummary(infoHash: string): TorrentSummary | null {
		const row = this.connection
			.query<TorrentSummaryRow, [string]>(
				`SELECT h.info_hash, h.name, h.first_seen, h.last_seen,
				        COALESCE(c.bytes, 0) AS cached_bytes
				 FROM torrent_history AS h
				 LEFT JOIN torrent_cache AS c ON c.info_hash = h.info_hash
				 WHERE h.info_hash = ?`
			)
			.get(infoHash)
		return row ? this.toTorrentSummary(row) : null
	}

	getTorrentStatusSummary(infoHash: string): TorrentStatusSummary | null {
		const row = this.connection
			.query<TorrentStatusSummaryRow, [string]>(
				`SELECT h.info_hash, h.name, h.first_seen, h.last_seen,
				        COALESCE(c.bytes, 0) AS cached_bytes,
				        CASE WHEN m.info_hash IS NULL THEN 0 ELSE 1 END AS metadata_ready,
				        COALESCE(m.completed, 0) AS metadata_completed,
				        COALESCE(c.completed, 0) AS cache_completed
				 FROM torrent_history AS h
				 LEFT JOIN torrent_metadata AS m ON m.info_hash = h.info_hash
				 LEFT JOIN torrent_cache AS c ON c.info_hash = h.info_hash
				 WHERE h.info_hash = ?`
			)
			.get(infoHash)
		return row ? this.toTorrentStatusSummary(row) : null
	}

	healthCheck(): { historyRows: number; integrity: string } {
		const integrity = this.connection
			.query<{ quick_check: string }, []>('PRAGMA quick_check')
			.get()?.quick_check
		const historyRows = this.connection
			.query<{ count: number }, []>(
				'SELECT COUNT(*) AS count FROM torrent_history'
			)
			.get()?.count
		return {
			historyRows: historyRows ?? 0,
			integrity: integrity ?? 'unknown',
		}
	}

	listCacheEntries(): CacheEntry[] {
		return this.connection
			.query<CacheEntryRow, []>(
				`SELECT info_hash, bytes, completed, last_accessed
				 FROM torrent_cache
				 ORDER BY last_accessed ASC`
			)
			.all()
			.map((row) => ({
				bytes: row.bytes,
				completed: row.completed === 1,
				infoHash: row.info_hash,
				lastAccessed: normalizeTimestamp(row.last_accessed),
			}))
	}

	listTorrents(): TorrentSummary[] {
		return this.connection
			.query<TorrentSummaryRow, []>(
				`SELECT h.info_hash, h.name, h.first_seen, h.last_seen,
				        COALESCE(c.bytes, 0) AS cached_bytes
				 FROM torrent_history AS h
				 LEFT JOIN torrent_cache AS c ON c.info_hash = h.info_hash
				 ORDER BY h.last_seen DESC, h.info_hash ASC`
			)
			.all()
			.map((row) => this.toTorrentSummary(row))
	}

	listTorrentStatusSummaries(): TorrentStatusSummary[] {
		return this.connection
			.query<TorrentStatusSummaryRow, []>(
				`SELECT h.info_hash, h.name, h.first_seen, h.last_seen,
				        COALESCE(c.bytes, 0) AS cached_bytes,
				        CASE WHEN m.info_hash IS NULL THEN 0 ELSE 1 END AS metadata_ready,
				        COALESCE(m.completed, 0) AS metadata_completed,
				        COALESCE(c.completed, 0) AS cache_completed
				 FROM torrent_history AS h
				 LEFT JOIN torrent_metadata AS m ON m.info_hash = h.info_hash
				 LEFT JOIN torrent_cache AS c ON c.info_hash = h.info_hash
				 ORDER BY h.last_seen DESC, h.info_hash ASC`
			)
			.all()
			.map((row) => this.toTorrentStatusSummary(row))
	}

	listTorrentRegistrations(): TorrentRegistrationRecord[] {
		return this.connection
			.query<TorrentRegistrationRow, []>(
				`SELECT info_hash, torrent_id, background_download
				 FROM torrent_registrations
				 ORDER BY created_at ASC, info_hash ASC`
			)
			.all()
			.map((row) => ({
				backgroundDownload: row.background_download === 1,
				infoHash: row.info_hash,
				torrentId: row.torrent_id,
			}))
	}

	recordCache(infoHash: string, bytes: number, completed: boolean): void {
		this.connection
			.query(
				`INSERT INTO torrent_cache (info_hash, bytes, completed, last_accessed)
				 VALUES (?, ?, ?, ${nowExpression})
				 ON CONFLICT(info_hash) DO UPDATE SET
				   bytes = excluded.bytes,
				   completed = excluded.completed,
				   last_accessed = excluded.last_accessed`
			)
			.run(infoHash, bytes, completed ? 1 : 0)
	}

	removeCacheEntry(infoHash: string): void {
		this.connection
			.query('DELETE FROM torrent_cache WHERE info_hash = ?')
			.run(infoHash)
	}

	recordTorrentRegistration(
		infoHash: string,
		name: string,
		torrentId: string,
		backgroundDownload: boolean
	): void {
		const write = this.connection.transaction(() => {
			this.connection
				.query(
					`INSERT INTO torrent_history
					   (info_hash, name, first_seen, last_seen)
					 VALUES (?, ?, ${nowExpression}, ${nowExpression})
					 ON CONFLICT(info_hash) DO UPDATE SET
					   last_seen = excluded.last_seen`
				)
				.run(infoHash, name)
			this.connection
				.query(
					`INSERT INTO torrent_registrations
					   (info_hash, torrent_id, background_download, created_at, updated_at)
					 VALUES (?, ?, ?, ${nowExpression}, ${nowExpression})
					 ON CONFLICT(info_hash) DO UPDATE SET
					   torrent_id = excluded.torrent_id,
					   background_download = excluded.background_download,
					   updated_at = excluded.updated_at`
				)
				.run(infoHash, torrentId, backgroundDownload ? 1 : 0)
		})
		write.immediate()
	}

	saveFileModtimes(
		infoHash: string,
		fileModtimes: number[],
		completed: boolean
	): void {
		this.connection
			.query(
				`UPDATE torrent_metadata
				 SET file_modtimes = ?, completed = ?, updated_at = ${nowExpression}
				 WHERE info_hash = ?`
			)
			.run(JSON.stringify(fileModtimes), completed ? 1 : 0, infoHash)
	}

	touchTorrent(infoHash: string): void {
		this.connection
			.query(
				`UPDATE torrent_history SET last_seen = ${nowExpression}
				 WHERE info_hash = ?`
			)
			.run(infoHash)
		this.connection
			.query(
				`UPDATE torrent_cache SET last_accessed = ${nowExpression}
				 WHERE info_hash = ?`
			)
			.run(infoHash)
	}

	upsertTorrent(
		infoHash: string,
		name: string,
		torrentFile: Uint8Array,
		magnetUri: string
	): void {
		const write = this.connection.transaction(() => {
			this.connection
				.query(
					`INSERT INTO torrent_history
					   (info_hash, name, first_seen, last_seen)
					 VALUES (?, ?, ${nowExpression}, ${nowExpression})
					 ON CONFLICT(info_hash) DO UPDATE SET
					   name = excluded.name,
					   last_seen = excluded.last_seen`
				)
				.run(infoHash, name)
			this.connection
				.query(
					`INSERT INTO torrent_metadata
					   (info_hash, torrent_file, magnet_uri, updated_at)
					 VALUES (?, ?, ?, ${nowExpression})
					 ON CONFLICT(info_hash) DO UPDATE SET
					   torrent_file = excluded.torrent_file,
					   magnet_uri = excluded.magnet_uri,
					   updated_at = excluded.updated_at`
				)
				.run(infoHash, torrentFile, magnetUri)
		})
		write.immediate()
	}

	private migrate(): void {
		this.connection.exec(`
			CREATE TABLE IF NOT EXISTS torrent_history (
				info_hash TEXT PRIMARY KEY,
				name TEXT NOT NULL,
				first_seen TEXT NOT NULL DEFAULT (${nowExpression}),
				last_seen TEXT NOT NULL DEFAULT (${nowExpression})
			);
			CREATE INDEX IF NOT EXISTS torrent_history_last_seen
				ON torrent_history(last_seen DESC);
			CREATE TABLE IF NOT EXISTS torrent_metadata (
				info_hash TEXT PRIMARY KEY
					REFERENCES torrent_history(info_hash) ON DELETE CASCADE,
				torrent_file BLOB NOT NULL,
				magnet_uri TEXT NOT NULL,
				file_modtimes TEXT,
				completed INTEGER NOT NULL DEFAULT 0 CHECK (completed IN (0, 1)),
				updated_at TEXT NOT NULL DEFAULT (${nowExpression})
			);
			CREATE TABLE IF NOT EXISTS torrent_cache (
				info_hash TEXT PRIMARY KEY
					REFERENCES torrent_history(info_hash) ON DELETE CASCADE,
				bytes INTEGER NOT NULL DEFAULT 0 CHECK (bytes >= 0),
				completed INTEGER NOT NULL DEFAULT 0 CHECK (completed IN (0, 1)),
				last_accessed TEXT NOT NULL DEFAULT (${nowExpression})
			);
			CREATE TABLE IF NOT EXISTS torrent_registrations (
				info_hash TEXT PRIMARY KEY
					REFERENCES torrent_history(info_hash) ON DELETE CASCADE,
				torrent_id TEXT NOT NULL,
				background_download INTEGER NOT NULL DEFAULT 0
					CHECK (background_download IN (0, 1)),
				created_at TEXT NOT NULL DEFAULT (${nowExpression}),
				updated_at TEXT NOT NULL DEFAULT (${nowExpression})
			);
		`)
	}

	private toTorrentSummary(row: TorrentSummaryRow): TorrentSummary {
		return {
			cachedBytes: row.cached_bytes ?? 0,
			firstSeen: normalizeTimestamp(row.first_seen),
			infoHash: row.info_hash,
			lastSeen: normalizeTimestamp(row.last_seen),
			name: row.name,
		}
	}

	private toTorrentStatusSummary(
		row: TorrentStatusSummaryRow
	): TorrentStatusSummary {
		return {
			...this.toTorrentSummary(row),
			cacheCompleted: row.cache_completed === 1,
			metadataCompleted: row.metadata_completed === 1,
			metadataReady: row.metadata_ready === 1,
		}
	}
}

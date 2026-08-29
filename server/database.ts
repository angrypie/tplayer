import { Database } from 'bun:sqlite'

export interface TorrentSummary {
	cachedBytes: number
	firstSeen: string
	infoHash: string
	lastSeen: string
	name: string
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
			.map((row) => ({
				cachedBytes: row.cached_bytes ?? 0,
				firstSeen: normalizeTimestamp(row.first_seen),
				infoHash: row.info_hash,
				lastSeen: normalizeTimestamp(row.last_seen),
				name: row.name,
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
		`)
	}
}

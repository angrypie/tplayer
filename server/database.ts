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
	totalFileBytes: number
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

export interface StoredTorrentFile {
	fileId: string
	length: number
	mimeType: string
	name: string
	path: string[]
	storagePath: string[]
}

export interface CacheEntry {
	bytes: number
	completed: boolean
	infoHash: string
	lastAccessed: string
}

export type TranscriptionJobState =
	| 'cancelled'
	| 'completed'
	| 'failed'
	| 'preparing'
	| 'queued'
	| 'transcribing'

export type TranscriptionJobTrigger = 'automatic' | 'manual'

export interface TranscriptionJobRecord {
	attempt: number
	createdAt: string
	errorAmbiguous: boolean
	errorCode: string | null
	errorMessage: string | null
	errorRetryable: boolean
	fileId: string
	fileLength: number
	filePath: string
	finishedAt: string | null
	infoHash: string
	model: string
	processedMilliseconds: number
	provider: string
	startedAt: string | null
	state: TranscriptionJobState
	totalMilliseconds: number | null
	trigger: TranscriptionJobTrigger
	updatedAt: string
}

export interface CaptionArtifactRecord {
	bytes: Uint8Array
	createdAt: string
	cueCount: number
	durationMilliseconds: number
	fileLength: number
	filePath: string
	formatVersion: number
	infoHash: string
	language: string | null
	model: string
	provider: string
	sha256: string
	updatedAt: string
}

export interface CaptionArtifactMetadata
	extends Omit<CaptionArtifactRecord, 'bytes'> {
	byteLength: number
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
	total_file_bytes: number
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

interface StoredTorrentFileRow {
	display_path: string
	file_id: string
	file_length: number
	file_name: string
	info_hash: string
	mime_type: string
	storage_path: string
}

interface TranscriptionJobRow {
	attempt: number
	created_at: string
	error_ambiguous: number
	error_code: string | null
	error_message: string | null
	error_retryable: number
	file_id: string
	file_length: number
	file_path: string
	finished_at: string | null
	info_hash: string
	model: string
	processed_ms: number
	provider: string
	started_at: string | null
	state: TranscriptionJobState
	total_ms: number | null
	trigger: TranscriptionJobTrigger
	updated_at: string
}

interface CaptionArtifactRow {
	bytes: Uint8Array
	created_at: string
	cue_count: number
	duration_ms: number
	file_length: number
	file_path: string
	format_version: number
	info_hash: string
	language: string | null
	model: string
	provider: string
	sha256: string
	updated_at: string
}

interface CaptionArtifactMetadataRow extends Omit<CaptionArtifactRow, 'bytes'> {
	byte_length: number
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

const nextCaptionArtifactUpdatedAt = (
	candidate: string,
	previous?: string
): string => {
	const candidateMilliseconds = Date.parse(normalizeTimestamp(candidate))
	if (Number.isNaN(candidateMilliseconds)) {
		throw new TypeError('Caption artifact updatedAt must be a valid timestamp')
	}
	if (!previous) {
		return new Date(candidateMilliseconds).toISOString()
	}
	const previousMilliseconds = Date.parse(normalizeTimestamp(previous))
	if (Number.isNaN(previousMilliseconds)) {
		throw new TypeError(
			'Persisted caption artifact updatedAt must be a valid timestamp'
		)
	}
	return new Date(
		Math.max(candidateMilliseconds, previousMilliseconds + 1)
	).toISOString()
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

	deleteTranscription(infoHash: string, filePath: string): void {
		const remove = this.connection.transaction(() => {
			this.connection
				.query(
					'DELETE FROM caption_artifacts WHERE info_hash = ? AND file_path = ?'
				)
				.run(infoHash, filePath)
			this.connection
				.query(
					'DELETE FROM transcription_jobs WHERE info_hash = ? AND file_path = ?'
				)
				.run(infoHash, filePath)
		})
		remove.immediate()
	}

	getAutomaticTranscriptionEnabled(): boolean {
		return (
			this.connection
				.query<{ automatic_enabled: number }, []>(
					`SELECT automatic_enabled
					 FROM transcription_settings
					 WHERE id = 1`
				)
				.get()?.automatic_enabled === 1
		)
	}

	setAutomaticTranscriptionEnabled(enabled: boolean): void {
		this.connection
			.query(
				`INSERT INTO transcription_settings (id, automatic_enabled, updated_at)
				 VALUES (1, ?, ${nowExpression})
				 ON CONFLICT(id) DO UPDATE SET
				   automatic_enabled = excluded.automatic_enabled,
				   updated_at = excluded.updated_at`
			)
			.run(enabled ? 1 : 0)
	}

	getCaptionArtifact(
		infoHash: string,
		filePath: string
	): CaptionArtifactRecord | null {
		const row = this.connection
			.query<CaptionArtifactRow, [string, string]>(
				`SELECT info_hash, file_path, file_length, format_version,
				        provider, model, language, duration_ms, cue_count,
				        sha256, bytes, created_at, updated_at
				 FROM caption_artifacts
				 WHERE info_hash = ? AND file_path = ?`
			)
			.get(infoHash, filePath)
		return row ? this.toCaptionArtifact(row) : null
	}

	getCaptionArtifactMetadata(
		infoHash: string,
		filePath: string
	): CaptionArtifactMetadata | null {
		const row = this.connection
			.query<CaptionArtifactMetadataRow, [string, string]>(
				`SELECT info_hash, file_path, file_length, format_version,
				        provider, model, language, duration_ms, cue_count,
				        sha256, length(bytes) AS byte_length, created_at, updated_at
				 FROM caption_artifacts
				 WHERE info_hash = ? AND file_path = ?`
			)
			.get(infoHash, filePath)
		return row
			? {
					byteLength: row.byte_length,
					createdAt: normalizeTimestamp(row.created_at),
					cueCount: row.cue_count,
					durationMilliseconds: row.duration_ms,
					fileLength: row.file_length,
					filePath: row.file_path,
					formatVersion: row.format_version,
					infoHash: row.info_hash,
					language: row.language,
					model: row.model,
					provider: row.provider,
					sha256: row.sha256,
					updatedAt: normalizeTimestamp(row.updated_at),
				}
			: null
	}

	getTranscriptionJob(
		infoHash: string,
		filePath: string
	): TranscriptionJobRecord | null {
		const row = this.connection
			.query<TranscriptionJobRow, [string, string]>(
				`SELECT info_hash, file_path, file_id, file_length, trigger,
				        state, attempt, provider, model, processed_ms, total_ms,
				        error_code, error_message, error_retryable, error_ambiguous,
				        created_at, updated_at, started_at, finished_at
				 FROM transcription_jobs
				 WHERE info_hash = ? AND file_path = ?`
			)
			.get(infoHash, filePath)
		return row ? this.toTranscriptionJob(row) : null
	}

	listLocallyAvailableTorrentHashes(): string[] {
		return this.connection
			.query<{ info_hash: string }, []>(
				`SELECT m.info_hash
				 FROM torrent_metadata AS m
				 INNER JOIN torrent_cache AS c ON c.info_hash = m.info_hash
				 WHERE m.completed = 1 AND c.completed = 1
				 ORDER BY c.last_accessed DESC, m.info_hash ASC`
			)
			.all()
			.map((row) => row.info_hash)
	}

	listTranscriptionJobs(infoHash?: string): TranscriptionJobRecord[] {
		const fields = `SELECT info_hash, file_path, file_id, file_length, trigger,
		                     state, attempt, provider, model, processed_ms, total_ms,
		                     error_code, error_message, error_retryable,
		                     error_ambiguous, created_at, updated_at,
		                     started_at, finished_at
		              FROM transcription_jobs`
		const rows = infoHash
			? this.connection
					.query<TranscriptionJobRow, [string]>(
						`${fields} WHERE info_hash = ? ORDER BY file_id ASC`
					)
					.all(infoHash)
			: this.connection
					.query<TranscriptionJobRow, []>(
						`${fields} ORDER BY created_at ASC, info_hash ASC, file_id ASC`
					)
					.all()
		return rows.map((row) => this.toTranscriptionJob(row))
	}

	putTranscriptionJob(job: TranscriptionJobRecord): void {
		this.connection
			.query(
				`INSERT INTO transcription_jobs (
				   info_hash, file_path, file_id, file_length, trigger, state,
				   attempt, provider, model, processed_ms, total_ms,
				   error_code, error_message, error_retryable, error_ambiguous,
				   created_at, updated_at, started_at, finished_at
				 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT(info_hash, file_path) DO UPDATE SET
				   file_id = excluded.file_id,
				   file_length = excluded.file_length,
				   trigger = excluded.trigger,
				   state = excluded.state,
				   attempt = excluded.attempt,
				   provider = excluded.provider,
				   model = excluded.model,
				   processed_ms = excluded.processed_ms,
				   total_ms = excluded.total_ms,
				   error_code = excluded.error_code,
				   error_message = excluded.error_message,
				   error_retryable = excluded.error_retryable,
				   error_ambiguous = excluded.error_ambiguous,
				   updated_at = excluded.updated_at,
				   started_at = excluded.started_at,
				   finished_at = excluded.finished_at`
			)
			.run(
				job.infoHash,
				job.filePath,
				job.fileId,
				job.fileLength,
				job.trigger,
				job.state,
				job.attempt,
				job.provider,
				job.model,
				job.processedMilliseconds,
				job.totalMilliseconds,
				job.errorCode,
				job.errorMessage,
				job.errorRetryable ? 1 : 0,
				job.errorAmbiguous ? 1 : 0,
				job.createdAt,
				job.updatedAt,
				job.startedAt,
				job.finishedAt
			)
	}

	completeTranscription(
		job: TranscriptionJobRecord,
		artifact: CaptionArtifactRecord
	): void {
		const save = this.connection.transaction(() => {
			const previous = this.connection
				.query<{ updated_at: string }, [string, string]>(
					`SELECT updated_at
					 FROM caption_artifacts
					 WHERE info_hash = ? AND file_path = ?`
				)
				.get(artifact.infoHash, artifact.filePath)
			const artifactUpdatedAt = nextCaptionArtifactUpdatedAt(
				artifact.updatedAt,
				previous?.updated_at
			)
			this.connection
				.query(
					`INSERT INTO caption_artifacts (
					   info_hash, file_path, file_length, format_version, provider,
					   model, language, duration_ms, cue_count, sha256, bytes,
					   created_at, updated_at
					 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
					 ON CONFLICT(info_hash, file_path) DO UPDATE SET
					   file_length = excluded.file_length,
					   format_version = excluded.format_version,
					   provider = excluded.provider,
					   model = excluded.model,
					   language = excluded.language,
					   duration_ms = excluded.duration_ms,
					   cue_count = excluded.cue_count,
					   sha256 = excluded.sha256,
					   bytes = excluded.bytes,
					   updated_at = excluded.updated_at`
				)
				.run(
					artifact.infoHash,
					artifact.filePath,
					artifact.fileLength,
					artifact.formatVersion,
					artifact.provider,
					artifact.model,
					artifact.language,
					artifact.durationMilliseconds,
					artifact.cueCount,
					artifact.sha256,
					artifact.bytes,
					artifact.createdAt,
					artifactUpdatedAt
				)
			this.putTranscriptionJob(job)
		})
		save.immediate()
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
				        COALESCE(c.completed, 0) AS cache_completed,
				        COALESCE((
				          SELECT SUM(f.file_length)
				          FROM torrent_files AS f
				          WHERE f.info_hash = h.info_hash
				        ), 0) AS total_file_bytes
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
				        COALESCE(c.completed, 0) AS cache_completed,
				        COALESCE((
				          SELECT SUM(f.file_length)
				          FROM torrent_files AS f
				          WHERE f.info_hash = h.info_hash
				        ), 0) AS total_file_bytes
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

	listTorrentFiles(infoHash: string): StoredTorrentFile[] {
		return this.connection
			.query<StoredTorrentFileRow, [string]>(
				`SELECT info_hash, file_id, file_name, file_length, mime_type,
				        display_path, storage_path
				 FROM torrent_files
				 WHERE info_hash = ?
				 ORDER BY CAST(file_id AS INTEGER), file_id`
			)
			.all(infoHash)
			.map((row) => ({
				fileId: row.file_id,
				length: row.file_length,
				mimeType: row.mime_type,
				name: row.file_name,
				path: JSON.parse(row.display_path) as string[],
				storagePath: JSON.parse(row.storage_path) as string[],
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

	replaceTorrentFiles(
		infoHash: string,
		files: readonly StoredTorrentFile[]
	): void {
		const replace = this.connection.transaction(() => {
			this.connection
				.query('DELETE FROM torrent_files WHERE info_hash = ?')
				.run(infoHash)
			const insert = this.connection.query(
				`INSERT INTO torrent_files (
				   info_hash, file_id, file_name, file_length, mime_type,
				   display_path, storage_path
				 ) VALUES (?, ?, ?, ?, ?, ?, ?)`
			)
			for (const file of files) {
				insert.run(
					infoHash,
					file.fileId,
					file.name,
					file.length,
					file.mimeType,
					JSON.stringify(file.path),
					JSON.stringify(file.storagePath)
				)
			}
		})
		replace.immediate()
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
			CREATE TABLE IF NOT EXISTS torrent_files (
				info_hash TEXT NOT NULL
					REFERENCES torrent_history(info_hash) ON DELETE CASCADE,
				file_id TEXT NOT NULL,
				file_name TEXT NOT NULL,
				file_length INTEGER NOT NULL CHECK (file_length >= 0),
				mime_type TEXT NOT NULL,
				display_path TEXT NOT NULL,
				storage_path TEXT NOT NULL,
				PRIMARY KEY (info_hash, file_id)
			);
			CREATE TABLE IF NOT EXISTS transcription_settings (
				id INTEGER PRIMARY KEY CHECK (id = 1),
				automatic_enabled INTEGER NOT NULL DEFAULT 0
					CHECK (automatic_enabled IN (0, 1)),
				updated_at TEXT NOT NULL DEFAULT (${nowExpression})
			);
			INSERT OR IGNORE INTO transcription_settings (id, automatic_enabled)
				VALUES (1, 0);
			CREATE TABLE IF NOT EXISTS transcription_jobs (
				info_hash TEXT NOT NULL
					REFERENCES torrent_history(info_hash) ON DELETE CASCADE,
				file_path TEXT NOT NULL,
				file_id TEXT NOT NULL,
				file_length INTEGER NOT NULL CHECK (file_length >= 0),
				trigger TEXT NOT NULL CHECK (trigger IN ('automatic', 'manual')),
				state TEXT NOT NULL CHECK (
					state IN (
						'queued', 'preparing', 'transcribing', 'completed',
						'failed', 'cancelled'
					)
				),
				attempt INTEGER NOT NULL CHECK (attempt > 0),
				provider TEXT NOT NULL,
				model TEXT NOT NULL,
				processed_ms INTEGER NOT NULL DEFAULT 0 CHECK (processed_ms >= 0),
				total_ms INTEGER CHECK (total_ms IS NULL OR total_ms >= 0),
				error_code TEXT,
				error_message TEXT,
				error_retryable INTEGER NOT NULL DEFAULT 0
					CHECK (error_retryable IN (0, 1)),
				error_ambiguous INTEGER NOT NULL DEFAULT 0
					CHECK (error_ambiguous IN (0, 1)),
				created_at TEXT NOT NULL DEFAULT (${nowExpression}),
				updated_at TEXT NOT NULL DEFAULT (${nowExpression}),
				started_at TEXT,
				finished_at TEXT,
				PRIMARY KEY (info_hash, file_path)
			);
			CREATE INDEX IF NOT EXISTS transcription_jobs_state
				ON transcription_jobs(state, created_at);
			CREATE TABLE IF NOT EXISTS caption_artifacts (
				info_hash TEXT NOT NULL
					REFERENCES torrent_history(info_hash) ON DELETE CASCADE,
				file_path TEXT NOT NULL,
				file_length INTEGER NOT NULL CHECK (file_length >= 0),
				format_version INTEGER NOT NULL CHECK (format_version > 0),
				provider TEXT NOT NULL,
				model TEXT NOT NULL,
				language TEXT,
				duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0),
				cue_count INTEGER NOT NULL CHECK (cue_count >= 0),
				sha256 TEXT NOT NULL,
				bytes BLOB NOT NULL,
				created_at TEXT NOT NULL DEFAULT (${nowExpression}),
				updated_at TEXT NOT NULL DEFAULT (${nowExpression}),
				PRIMARY KEY (info_hash, file_path)
			);
		`)
	}

	private toCaptionArtifact(row: CaptionArtifactRow): CaptionArtifactRecord {
		return {
			bytes: new Uint8Array(row.bytes),
			createdAt: normalizeTimestamp(row.created_at),
			cueCount: row.cue_count,
			durationMilliseconds: row.duration_ms,
			fileLength: row.file_length,
			filePath: row.file_path,
			formatVersion: row.format_version,
			infoHash: row.info_hash,
			language: row.language,
			model: row.model,
			provider: row.provider,
			sha256: row.sha256,
			updatedAt: normalizeTimestamp(row.updated_at),
		}
	}

	private toTranscriptionJob(row: TranscriptionJobRow): TranscriptionJobRecord {
		return {
			attempt: row.attempt,
			createdAt: normalizeTimestamp(row.created_at),
			errorAmbiguous: row.error_ambiguous === 1,
			errorCode: row.error_code,
			errorMessage: row.error_message,
			errorRetryable: row.error_retryable === 1,
			fileId: row.file_id,
			fileLength: row.file_length,
			filePath: row.file_path,
			finishedAt: row.finished_at ? normalizeTimestamp(row.finished_at) : null,
			infoHash: row.info_hash,
			model: row.model,
			processedMilliseconds: row.processed_ms,
			provider: row.provider,
			startedAt: row.started_at ? normalizeTimestamp(row.started_at) : null,
			state: row.state,
			totalMilliseconds: row.total_ms,
			trigger: row.trigger,
			updatedAt: normalizeTimestamp(row.updated_at),
		}
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
			totalFileBytes: row.total_file_bytes,
		}
	}
}

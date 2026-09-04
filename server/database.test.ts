import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	AppDatabase,
	type CaptionArtifactRecord,
	type TranscriptionJobRecord,
} from './database'
import { reportBenchmark } from './test/benchmark'

const DATABASE_TEST_TIMEOUT_MS = 15_000
const HISTORY_ROWS = 10_000
const MIB = 1024 * 1024

const createTestRoot = async (): Promise<string> =>
	await mkdtemp(join(tmpdir(), 'tplayer-database-'))

const historyHash = (value: number): string =>
	value.toString(16).padStart(40, '0')

describe('AppDatabase integration', () => {
	test(
		'migrates the deployed history schema in place and preserves ordering, first-seen, cache metadata, and deletion durability',
		async () => {
			const root = await createTestRoot()
			const databasePath = join(root, 'tplayer_history.sqlite')
			const legacy = new Database(databasePath, { create: true, strict: true })
			legacy.exec(`
				CREATE TABLE torrent_history (
					info_hash TEXT PRIMARY KEY,
					name TEXT NOT NULL,
					first_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
					last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP
				)
			`)
			legacy
				.query(
					`INSERT INTO torrent_history (info_hash, name, first_seen, last_seen)
					 VALUES (?, ?, ?, ?)`
				)
				.run(
					historyHash(1),
					'Older audiobook',
					'2024-01-02 03:04:05',
					'2024-02-03 04:05:06'
				)
			legacy
				.query(
					`INSERT INTO torrent_history (info_hash, name, first_seen, last_seen)
					 VALUES (?, ?, ?, ?)`
				)
				.run(
					historyHash(2),
					'Newer audiobook',
					'2024-03-04 05:06:07',
					'2024-04-05 06:07:08'
				)
			legacy.close()

			let database: AppDatabase | null = new AppDatabase(databasePath)
			try {
				const migrated = database.listTorrents()
				expect(migrated.map((torrent) => torrent.infoHash)).toEqual([
					historyHash(2),
					historyHash(1),
				])
				expect(migrated[1]?.firstSeen).toBe('2024-01-02T03:04:05.000Z')

				const firstSeen = migrated[1]?.firstSeen
				const torrentFile = Uint8Array.from([
					100, 8, 105, 110, 102, 111, 100, 101,
				])
				database.upsertTorrent(
					historyHash(1),
					'Older audiobook, renamed',
					torrentFile,
					`magnet:?xt=urn:btih:${historyHash(1)}`
				)
				database.recordCache(historyHash(1), 12 * MIB + 17, true)
				database.replaceTorrentFiles(historyHash(1), [
					{
						fileId: '0',
						length: 8 * MIB,
						mimeType: 'audio/mpeg',
						name: 'chapter-1.mp3',
						path: ['chapter-1.mp3'],
						storagePath: ['Older audiobook', 'chapter-1.mp3'],
					},
					{
						fileId: '1',
						length: 6 * MIB,
						mimeType: 'audio/mpeg',
						name: 'chapter-2.mp3',
						path: ['chapter-2.mp3'],
						storagePath: ['Older audiobook', 'chapter-2.mp3'],
					},
				])
				expect(
					database.getTorrentStatusSummary(historyHash(1))?.totalFileBytes
				).toBe(14 * MIB)
				expect(
					database
						.listTorrentStatusSummaries()
						.find((torrent) => torrent.infoHash === historyHash(1))
						?.totalFileBytes
				).toBe(14 * MIB)
				const afterUpsert = database
					.listTorrents()
					.find((torrent) => torrent.infoHash === historyHash(1))
				expect(afterUpsert?.firstSeen).toBe(firstSeen)
				expect(afterUpsert?.name).toBe('Older audiobook, renamed')
				expect(afterUpsert?.cachedBytes).toBe(12 * MIB + 17)

				database.close()
				database = new AppDatabase(databasePath)
				const reopened = database.getMetadata(historyHash(1))
				expect(reopened?.torrentFile).toEqual(torrentFile)
				expect(database.deleteTorrent(historyHash(1))).toBe(true)
				expect(database.deleteTorrent(historyHash(1))).toBe(false)
				expect(database.getMetadata(historyHash(1))).toBeNull()
				expect(
					database
						.listCacheEntries()
						.some((entry) => entry.infoHash === historyHash(1))
				).toBe(false)

				database.close()
				database = new AppDatabase(databasePath)
				expect(
					database.listTorrents().map((torrent) => torrent.infoHash)
				).toEqual([historyHash(2)])
				expect(database.healthCheck().integrity).toBe('ok')
			} finally {
				database?.close()
				await rm(root, { force: true, recursive: true })
			}
		},
		DATABASE_TEST_TIMEOUT_MS
	)

	test(
		'keeps one durable history row under repeated metadata writes for the same info hash',
		async () => {
			const root = await createTestRoot()
			const database = new AppDatabase(join(root, 'history.sqlite'))
			try {
				const infoHash = historyHash(77)
				const torrentFile = Uint8Array.from([1, 2, 3, 4])
				for (let write = 0; write < 250; write += 1) {
					database.upsertTorrent(
						infoHash,
						`Audiobook revision ${write}`,
						torrentFile,
						`magnet:?xt=urn:btih:${infoHash}`
					)
				}
				const matches = database
					.listTorrents()
					.filter((torrent) => torrent.infoHash === infoHash)
				expect(matches).toHaveLength(1)
				expect(matches[0]?.name).toBe('Audiobook revision 249')
			} finally {
				database.close()
				await rm(root, { force: true, recursive: true })
			}
		},
		DATABASE_TEST_TIMEOUT_MS
	)

	test(
		'persists pending background registrations before metadata and cascades their deletion',
		async () => {
			const root = await createTestRoot()
			const databasePath = join(root, 'history.sqlite')
			let database: AppDatabase | null = new AppDatabase(databasePath)
			try {
				const infoHash = historyHash(88)
				const torrentId = `magnet:?xt=urn:btih:${infoHash}&dn=Pending%20book`
				database.recordTorrentRegistration(
					infoHash,
					'Pending book',
					torrentId,
					true
				)
				const pending = database.getTorrentSummary(infoHash)
				expect(pending?.cachedBytes).toBe(0)
				expect(pending?.name).toBe('Pending book')
				expect(Number.isNaN(new Date(pending?.firstSeen ?? '').getTime())).toBe(
					false
				)
				expect(database.listTorrentRegistrations()).toEqual([
					{
						backgroundDownload: true,
						infoHash,
						torrentId,
					},
				])

				database.upsertTorrent(
					infoHash,
					'Book title from metadata',
					Uint8Array.from([1, 2, 3, 4]),
					torrentId
				)
				database.recordTorrentRegistration(
					infoHash,
					'Pending placeholder must not win',
					torrentId,
					false
				)
				expect(database.getTorrentSummary(infoHash)?.name).toBe(
					'Book title from metadata'
				)

				database.close()
				database = new AppDatabase(databasePath)
				expect(database.listTorrentRegistrations()).toEqual([
					{
						backgroundDownload: false,
						infoHash,
						torrentId,
					},
				])
				expect(database.deleteTorrent(infoHash)).toBe(true)
				expect(database.listTorrentRegistrations()).toEqual([])
			} finally {
				database?.close()
				await rm(root, { force: true, recursive: true })
			}
		},
		DATABASE_TEST_TIMEOUT_MS
	)

	test(
		'persists transcription settings, jobs, and compact caption blobs atomically and cascades cleanup',
		async () => {
			const root = await createTestRoot()
			const databasePath = join(root, 'history.sqlite')
			let database: AppDatabase | null = new AppDatabase(databasePath)
			try {
				const infoHash = historyHash(991)
				database.recordTorrentRegistration(
					infoHash,
					'Captioned audiobook',
					`magnet:?xt=urn:btih:${infoHash}`,
					true
				)
				database.replaceTorrentFiles(infoHash, [
					{
						fileId: '0',
						length: 1234,
						mimeType: 'audio/wav',
						name: 'chapter.wav',
						path: ['Book', 'chapter.wav'],
						storagePath: ['Captioned audiobook', 'Book', 'chapter.wav'],
					},
				])
				expect(database.getAutomaticTranscriptionEnabled()).toBe(false)
				database.setAutomaticTranscriptionEnabled(true)

				const timestamp = new Date().toISOString()
				const queuedJob = {
					attempt: 1,
					createdAt: timestamp,
					errorAmbiguous: false,
					errorCode: null,
					errorMessage: null,
					errorRetryable: false,
					fileId: '0',
					fileLength: 1234,
					filePath: 'Book/chapter.wav',
					finishedAt: null,
					infoHash,
					model: 'test-model',
					processedMilliseconds: 0,
					provider: 'test-provider',
					startedAt: null,
					state: 'queued',
					totalMilliseconds: null,
					trigger: 'automatic',
					updatedAt: timestamp,
				} satisfies TranscriptionJobRecord
				database.putTranscriptionJob(queuedJob)
				const bytes = Uint8Array.from([0x54, 0x43, 0x41, 0x50, 1, 2, 3, 4])
				const artifact = {
					bytes,
					createdAt: timestamp,
					cueCount: 2,
					durationMilliseconds: 12_345,
					fileLength: queuedJob.fileLength,
					filePath: queuedJob.filePath,
					formatVersion: 1,
					infoHash,
					language: 'en',
					model: queuedJob.model,
					provider: queuedJob.provider,
					sha256: '0123456789abcdef',
					updatedAt: timestamp,
				} satisfies CaptionArtifactRecord
				const completedJob = {
					...queuedJob,
					finishedAt: timestamp,
					processedMilliseconds: artifact.durationMilliseconds,
					startedAt: timestamp,
					state: 'completed',
					totalMilliseconds: artifact.durationMilliseconds,
				} satisfies TranscriptionJobRecord
				database.completeTranscription(completedJob, artifact)

				expect(
					database.getCaptionArtifactMetadata(infoHash, artifact.filePath)
				).toMatchObject({
					byteLength: bytes.byteLength,
					cueCount: 2,
					language: 'en',
					sha256: artifact.sha256,
				})
				expect(
					'bytes' in
						(database.getCaptionArtifactMetadata(infoHash, artifact.filePath) ??
							{})
				).toBe(false)

				database.close()
				database = new AppDatabase(databasePath)
				expect(database.getAutomaticTranscriptionEnabled()).toBe(true)
				expect(database.listTorrentFiles(infoHash)).toEqual([
					{
						fileId: '0',
						length: 1234,
						mimeType: 'audio/wav',
						name: 'chapter.wav',
						path: ['Book', 'chapter.wav'],
						storagePath: ['Captioned audiobook', 'Book', 'chapter.wav'],
					},
				])
				expect(
					database.getTranscriptionJob(infoHash, artifact.filePath)?.state
				).toBe('completed')
				expect(
					database.getCaptionArtifact(infoHash, artifact.filePath)?.bytes
				).toEqual(bytes)
				const firstArtifact = database.getCaptionArtifact(
					infoHash,
					artifact.filePath
				)
				if (!firstArtifact) {
					throw new Error('Initial caption artifact was not persisted')
				}
				const sameMillisecondBytes = Uint8Array.from([
					0x54, 0x43, 0x41, 0x50, 5, 6, 7, 8,
				])
				database.completeTranscription(completedJob, {
					...artifact,
					bytes: sameMillisecondBytes,
					sha256: 'same-millisecond-replacement',
					updatedAt: firstArtifact.updatedAt,
				})
				const sameMillisecondArtifact = database.getCaptionArtifact(
					infoHash,
					artifact.filePath
				)
				if (!sameMillisecondArtifact) {
					throw new Error('Same-millisecond replacement was not persisted')
				}
				expect(sameMillisecondArtifact.bytes).toEqual(sameMillisecondBytes)
				expect(sameMillisecondArtifact.updatedAt).toBe(
					new Date(Date.parse(firstArtifact.updatedAt) + 1).toISOString()
				)

				const backwardsClockBytes = Uint8Array.from([
					0x54, 0x43, 0x41, 0x50, 9, 10, 11, 12,
				])
				database.completeTranscription(completedJob, {
					...artifact,
					bytes: backwardsClockBytes,
					sha256: 'backwards-clock-replacement',
					updatedAt: new Date(
						Date.parse(firstArtifact.updatedAt) - 60_000
					).toISOString(),
				})
				const backwardsClockArtifact = database.getCaptionArtifact(
					infoHash,
					artifact.filePath
				)
				if (!backwardsClockArtifact) {
					throw new Error('Backwards-clock replacement was not persisted')
				}
				expect(backwardsClockArtifact.bytes).toEqual(backwardsClockBytes)
				expect(backwardsClockArtifact.updatedAt).toBe(
					new Date(
						Date.parse(sameMillisecondArtifact.updatedAt) + 1
					).toISOString()
				)

				const invalidPath = 'Book/invalid.wav'
				const pendingInvalid = {
					...queuedJob,
					fileId: '1',
					filePath: invalidPath,
				} satisfies TranscriptionJobRecord
				database.putTranscriptionJob(pendingInvalid)
				expect(() =>
					database?.completeTranscription(
						{ ...pendingInvalid, state: 'completed' },
						{
							...artifact,
							durationMilliseconds: -1,
							filePath: invalidPath,
						}
					)
				).toThrow()
				expect(database.getTranscriptionJob(infoHash, invalidPath)?.state).toBe(
					'queued'
				)
				expect(database.getCaptionArtifact(infoHash, invalidPath)).toBeNull()

				expect(database.deleteTorrent(infoHash)).toBe(true)
				expect(database.listTorrentFiles(infoHash)).toEqual([])
				expect(database.listTranscriptionJobs(infoHash)).toEqual([])
				expect(
					database.getCaptionArtifact(infoHash, artifact.filePath)
				).toBeNull()
			} finally {
				database?.close()
				await rm(root, { force: true, recursive: true })
			}
		},
		DATABASE_TEST_TIMEOUT_MS
	)

	test(
		'indexes and sorts ten thousand real history rows within a generous performance budget',
		async () => {
			const root = await createTestRoot()
			const database = new AppDatabase(join(root, 'history.sqlite'))
			try {
				const rssBefore = process.memoryUsage().rss
				const insert = database.connection.query(
					`INSERT INTO torrent_history (info_hash, name, first_seen, last_seen)
					 VALUES (?, ?, ?, ?)`
				)
				const insertAll = database.connection.transaction(() => {
					for (let index = 0; index < HISTORY_ROWS; index += 1) {
						const timestamp = new Date(
							Date.UTC(2025, 0, 1) + index * 1000
						).toISOString()
						insert.run(
							historyHash(index + 1),
							`Measured audiobook ${index + 1}`,
							timestamp,
							timestamp
						)
					}
				})
				const insertStartedAt = performance.now()
				insertAll.immediate()
				const insertDurationMs = performance.now() - insertStartedAt
				const listStartedAt = performance.now()
				const rows = database.listTorrents()
				const listDurationMs = performance.now() - listStartedAt
				const statusListStartedAt = performance.now()
				const statusRows = database.listTorrentStatusSummaries()
				const statusListDurationMs = performance.now() - statusListStartedAt
				const rssDeltaBytes = Math.max(0, process.memoryUsage().rss - rssBefore)
				const insertsPerSecond = HISTORY_ROWS / (insertDurationMs / 1000)

				expect(rows).toHaveLength(HISTORY_ROWS)
				expect(statusRows).toHaveLength(HISTORY_ROWS)
				expect(rows[0]?.infoHash).toBe(historyHash(HISTORY_ROWS))
				expect(rows.at(-1)?.infoHash).toBe(historyHash(1))
				expect(statusRows[0]).toMatchObject({
					cacheCompleted: false,
					infoHash: historyHash(HISTORY_ROWS),
					metadataCompleted: false,
					metadataReady: false,
				})
				expect(insertDurationMs).toBeLessThan(5000)
				expect(listDurationMs).toBeLessThan(2000)
				expect(statusListDurationMs).toBeLessThan(2000)
				expect(insertsPerSecond).toBeGreaterThan(1000)
				expect(rssDeltaBytes).toBeLessThan(256 * MIB)
				reportBenchmark('sqlite-history-10000', {
					insertMilliseconds: Number(insertDurationMs.toFixed(2)),
					insertsPerSecond: Math.round(insertsPerSecond),
					listMilliseconds: Number(listDurationMs.toFixed(2)),
					rows: HISTORY_ROWS,
					rssDeltaMiB: Number((rssDeltaBytes / MIB).toFixed(2)),
					statusListMilliseconds: Number(statusListDurationMs.toFixed(2)),
				})
			} finally {
				database.close()
				await rm(root, { force: true, recursive: true })
			}
		},
		DATABASE_TEST_TIMEOUT_MS
	)
})

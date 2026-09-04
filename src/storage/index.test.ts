/// <reference types="bun" />

import { describe, expect, test } from 'bun:test'
import Dexie from 'dexie'
import { IDBKeyRange, indexedDB } from 'fake-indexeddb'
import { type BookStorage, createStorage } from './index'

const INFO_HASH = '0123456789abcdef0123456789abcdef01234567'
const LEGACY_COMBINED_PATH = 'combined_Joh1thoh/0-1/Migrated audiobook/01.mp3'
const TEST_CHUNK_BYTES = 1024 * 1024

const uniqueDatabaseName = (label: string): string =>
	`tplayer-${label}-${crypto.randomUUID()}`

const exactBytes = async (blob: Blob): Promise<Uint8Array> =>
	new Uint8Array(await blob.arrayBuffer())

const createRepository = (databaseName: string): BookStorage =>
	createStorage({ databaseName, IDBKeyRange, indexedDB })

const seedVersionTwoDatabase = async (
	databaseName: string,
	bytes: Uint8Array
): Promise<void> => {
	const legacy = new Dexie(databaseName, { IDBKeyRange, indexedDB })
	legacy.version(2).stores({
		files: '[ih+path]',
		notes: '++id, ih',
		torrents: 'ih',
	})
	await legacy.open()
	const legacyHash = INFO_HASH.toUpperCase()
	await legacy.table('torrents').put({
		ih: legacyHash,
		info: JSON.stringify({
			files: [
				{
					length: bytes.byteLength,
					path: ['Migrated audiobook', '01.mp3'],
				},
			],
			length: bytes.byteLength,
			'name.utf-8': 'Migrated audiobook',
		}),
		state: {
			path: [['Migrated audiobook', '01.mp3']],
			time: 183.75,
			updatedAt: 1_725_000_000_123,
		},
	})
	await legacy.table('files').put({
		file: new Blob([Uint8Array.from(bytes).buffer], { type: 'audio/mpeg' }),
		ih: legacyHash,
		path: LEGACY_COMBINED_PATH,
	})
	await legacy.table('notes').add({
		ih: legacyHash,
		note: 'Resume after the interview',
		path: 'Migrated audiobook/01.mp3',
		time: 180,
	})
	legacy.close()
}

const seedVersionThreeDatabase = async (
	databaseName: string,
	bytes: Uint8Array<ArrayBuffer>
): Promise<void> => {
	const legacy = new Dexie(databaseName, { IDBKeyRange, indexedDB })
	legacy.version(3).stores({
		files: '[ih+path], ih',
		notes: '++id, ih, [ih+path]',
		torrents: 'ih, state.updatedAt',
	})
	await legacy.open()
	await legacy.table('files').put({
		file: new Blob([bytes], { type: 'audio/mpeg' }),
		ih: INFO_HASH,
		path: 'Legacy v3/01.mp3',
	})
	legacy.close()
}

const seedVersionSixDatabase = async (databaseName: string): Promise<void> => {
	const legacy = new Dexie(databaseName, { IDBKeyRange, indexedDB })
	legacy.version(6).stores({
		fileChunks: '[ih+path+index], [ih+path], ih',
		fileDownloads: '[ih+path], ih, updatedAt',
		files: '[ih+path], ih',
		notes: '++id, ih, [ih+path]',
		offlineGenerations: 'ih, updatedAt',
		offlineLeases: 'name, expiresAt',
		torrents: 'ih, state.updatedAt',
	})
	await legacy.open()
	await legacy.table('torrents').put({
		ih: INFO_HASH,
		info: { name: 'Version six book' },
		state: {
			path: ['Version six book', '01.mp3'],
			time: 37,
			updatedAt: 123,
		},
	})
	legacy.close()
}

const deterministicBytes = (length: number): Uint8Array<ArrayBuffer> =>
	Uint8Array.from({ length }, (_, index) => (index * 29 + 17) % 251)

const readRawFile = async (
	databaseName: string,
	path: string
): Promise<Record<string, unknown> | undefined> => {
	const database = await new Promise<IDBDatabase>((resolve, reject) => {
		const request = indexedDB.open(databaseName)
		request.onerror = () => reject(request.error)
		request.onsuccess = () => resolve(request.result)
	})
	try {
		return await new Promise<Record<string, unknown> | undefined>(
			(resolve, reject) => {
				const request = database
					.transaction('files', 'readonly')
					.objectStore('files')
					.get([INFO_HASH, path])
				request.onerror = () => reject(request.error)
				request.onsuccess = () =>
					resolve(request.result as Record<string, unknown> | undefined)
			}
		)
	} finally {
		database.close()
	}
}

describe('IndexedDB storage integration', () => {
	test('migrates a deployed v2 database in place without changing playback, notes, combined paths, or Blob bytes', async () => {
		const databaseName = uniqueDatabaseName('v2-migration')
		const bytes = Uint8Array.from([
			0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0xff, 0xfb, 0x90, 0x64,
		])
		await seedVersionTwoDatabase(databaseName, bytes)
		const repository = createRepository(databaseName)
		try {
			const torrent = await repository.getTorrent(INFO_HASH)
			expect(torrent).toEqual({
				ih: INFO_HASH,
				info: {
					files: [
						{
							length: bytes.byteLength,
							path: ['Migrated audiobook', '01.mp3'],
						},
					],
					length: bytes.byteLength,
					'name.utf-8': 'Migrated audiobook',
				},
				state: {
					path: ['Migrated audiobook', '01.mp3'],
					time: 183.75,
					updatedAt: 1_725_000_000_123,
				},
			})

			const combined = await repository.getFile(INFO_HASH, LEGACY_COMBINED_PATH)
			expect(combined?.file?.type).toBe('audio/mpeg')
			expect(await exactBytes(combined?.file ?? new Blob())).toEqual(bytes)
			expect(
				(await repository.getAllFilesForTorrent(INFO_HASH)).map(
					(file) => file.path
				)
			).toEqual([LEGACY_COMBINED_PATH])
			expect(await repository.getAllNotes(INFO_HASH)).toEqual([
				{
					id: 1,
					ih: INFO_HASH,
					note: 'Resume after the interview',
					path: 'Migrated audiobook/01.mp3',
					time: 180,
				},
			])
		} finally {
			await repository.deleteDatabase()
		}
	})

	test('coalesces concurrent idempotent file writes into one exact offline Blob', async () => {
		const databaseName = uniqueDatabaseName('concurrent-files')
		const repository = createRepository(databaseName)
		const bytes = Uint8Array.from({ length: 4096 }, (_, index) => index % 251)
		const blob = new Blob([bytes], { type: 'audio/mpeg' })
		try {
			await Promise.all(
				Array.from({ length: 64 }, async () => {
					await repository.addFile(INFO_HASH, 'Disc 1/01.mp3', blob)
				})
			)

			const storedFiles = await repository.getAllFilesForTorrent(INFO_HASH)
			expect(storedFiles).toHaveLength(1)
			expect(storedFiles[0]?.file?.type).toBe('audio/mpeg')
			expect(await exactBytes(storedFiles[0]?.file ?? new Blob())).toEqual(
				bytes
			)
		} finally {
			await repository.deleteDatabase()
		}
	})

	test('upgrades a deployed v3 Blob lazily without copying it into chunks', async () => {
		const databaseName = uniqueDatabaseName('v3-migration')
		const bytes = deterministicBytes(TEST_CHUNK_BYTES + 37)
		await seedVersionThreeDatabase(databaseName, bytes)
		const repository = createRepository(databaseName)
		try {
			const stored = await repository.getFile(INFO_HASH, 'Legacy v3/01.mp3')
			expect(stored?.storage).toBe('blob')
			expect(stored?.length).toBe(bytes.byteLength)
			expect(await exactBytes(stored?.file ?? new Blob())).toEqual(bytes)
			expect(
				await exactBytes(
					(await repository.getFileBlob(INFO_HASH, 'Legacy v3/01.mp3')) ??
						new Blob()
				)
			).toEqual(bytes)
			expect(
				await repository.getStoredFileChunkIndexes(
					INFO_HASH,
					'Legacy v3/01.mp3'
				)
			).toEqual(new Set())
			const raw = await readRawFile(databaseName, 'Legacy v3/01.mp3')
			expect(raw?.file).toBeInstanceOf(Blob)
			expect('length' in (raw ?? {})).toBe(false)
			expect('mimeType' in (raw ?? {})).toBe(false)
			expect('storage' in (raw ?? {})).toBe(false)
		} finally {
			await repository.deleteDatabase()
		}
	})

	test('adds compact caption storage to a deployed v6 database without changing library state', async () => {
		const databaseName = uniqueDatabaseName('v6-caption-migration')
		await seedVersionSixDatabase(databaseName)
		const repository = createRepository(databaseName)
		const bytes = Uint8Array.from([0x54, 0x43, 0x41, 0x50, 1, 2, 3, 4])
		try {
			expect(await repository.getTorrent(INFO_HASH)).toEqual({
				ih: INFO_HASH,
				info: { name: 'Version six book' },
				state: {
					path: ['Version six book', '01.mp3'],
					time: 37,
					updatedAt: 123,
				},
			})

			await repository.putCaptionTrack({
				bytes: bytes.buffer,
				cueCount: 2,
				durationMilliseconds: 4000,
				etag: '"tcap-test"',
				fileLength: 100,
				formatVersion: 1,
				ih: INFO_HASH.toUpperCase(),
				language: 'en',
				path: 'Version six book/01.mp3',
				updatedAt: 456,
			})

			const stored = await repository.getCaptionTrack(
				INFO_HASH,
				'Version six book/01.mp3'
			)
			expect(stored?.artifactUpdatedAt).toBeUndefined()
			expect(stored?.ih).toBe(INFO_HASH)
			expect(stored?.etag).toBe('"tcap-test"')
			expect(new Uint8Array(stored?.bytes ?? new ArrayBuffer(0))).toEqual(bytes)
		} finally {
			await repository.deleteDatabase()
		}
	})

	test('orders caption writes by server artifact revision before local completion time', async () => {
		const databaseName = uniqueDatabaseName('caption-artifact-order')
		const repository = createRepository(databaseName)
		const path = 'Caption artifact race/01.mp3'
		try {
			await repository.addTorrent(INFO_HASH, { name: 'Caption artifact race' })
			await repository.putCaptionTrack({
				artifactUpdatedAt: '2026-09-04T10:00:02.000Z',
				bytes: Uint8Array.from([2]).buffer,
				cueCount: 1,
				etag: '"tcap-newer"',
				fileLength: 100,
				formatVersion: 1,
				ih: INFO_HASH,
				path,
				updatedAt: 100,
			})
			await repository.putCaptionTrack({
				artifactUpdatedAt: '2026-09-04T10:00:01.000Z',
				bytes: Uint8Array.from([1]).buffer,
				cueCount: 1,
				etag: '"tcap-older"',
				fileLength: 100,
				formatVersion: 1,
				ih: INFO_HASH,
				path,
				updatedAt: 200,
			})

			let stored = await repository.getCaptionTrack(INFO_HASH, path)
			expect(stored?.etag).toBe('"tcap-newer"')
			expect(stored?.updatedAt).toBe(100)

			await repository.putCaptionTrack({
				artifactUpdatedAt: '2026-09-04T10:00:03.000Z',
				bytes: Uint8Array.from([3]).buffer,
				cueCount: 1,
				etag: '"tcap-newest"',
				fileLength: 100,
				formatVersion: 1,
				ih: INFO_HASH,
				path,
				updatedAt: 50,
			})

			stored = await repository.getCaptionTrack(INFO_HASH, path)
			expect(stored?.etag).toBe('"tcap-newest"')
			expect(stored?.updatedAt).toBe(50)
		} finally {
			await repository.deleteDatabase()
		}
	})

	test('fails closed for legacy and conflicting equal-revision caption writes', async () => {
		const databaseName = uniqueDatabaseName('caption-ambiguous-order')
		const repository = createRepository(databaseName)
		const path = 'Caption ambiguous race/01.mp3'
		const revision = '2026-09-04T10:00:02.000Z'
		try {
			await repository.addTorrent(INFO_HASH, { name: 'Caption ambiguous race' })
			await repository.putCaptionTrack({
				artifactUpdatedAt: revision,
				bytes: Uint8Array.from([2]).buffer,
				cueCount: 1,
				etag: '"tcap-current"',
				fileLength: 100,
				formatVersion: 1,
				ih: INFO_HASH,
				path,
				updatedAt: 100,
			})
			await repository.putCaptionTrack({
				bytes: Uint8Array.from([3]).buffer,
				cueCount: 1,
				etag: '"tcap-legacy"',
				fileLength: 100,
				formatVersion: 1,
				ih: INFO_HASH,
				path,
				updatedAt: 300,
			})
			await repository.putCaptionTrack({
				artifactUpdatedAt: revision,
				bytes: Uint8Array.from([4]).buffer,
				cueCount: 1,
				etag: '"tcap-conflict"',
				fileLength: 100,
				formatVersion: 1,
				ih: INFO_HASH,
				path,
				updatedAt: 400,
			})

			const stored = await repository.getCaptionTrack(INFO_HASH, path)
			expect(stored?.etag).toBe('"tcap-current"')
			expect(stored?.updatedAt).toBe(100)
		} finally {
			await repository.deleteDatabase()
		}
	})

	test('upgrades a legacy caption to a server-ordered artifact', async () => {
		const databaseName = uniqueDatabaseName('caption-legacy-upgrade')
		const repository = createRepository(databaseName)
		const path = 'Caption legacy upgrade/01.mp3'
		try {
			await repository.addTorrent(INFO_HASH, { name: 'Caption legacy upgrade' })
			await repository.putCaptionTrack({
				bytes: Uint8Array.from([1]).buffer,
				cueCount: 1,
				etag: '"tcap-legacy"',
				fileLength: 100,
				formatVersion: 1,
				ih: INFO_HASH,
				path,
				updatedAt: 200,
			})
			await repository.putCaptionTrack({
				artifactUpdatedAt: '2026-09-04T10:00:01.000Z',
				bytes: Uint8Array.from([2]).buffer,
				cueCount: 1,
				etag: '"tcap-versioned"',
				fileLength: 100,
				formatVersion: 1,
				ih: INFO_HASH,
				path,
				updatedAt: 100,
			})

			const stored = await repository.getCaptionTrack(INFO_HASH, path)
			expect(stored?.artifactUpdatedAt).toBe('2026-09-04T10:00:01.000Z')
			expect(stored?.etag).toBe('"tcap-versioned"')
			expect(stored?.updatedAt).toBe(100)
		} finally {
			await repository.deleteDatabase()
		}
	})

	test('conditionally removes only the exact observed caption record', async () => {
		const databaseName = uniqueDatabaseName('caption-conditional-delete')
		const repository = createRepository(databaseName)
		const path = 'Caption cleanup race/01.mp3'
		try {
			await repository.addTorrent(INFO_HASH, { name: 'Caption cleanup race' })
			await repository.putCaptionTrack({
				artifactUpdatedAt: '2026-09-04T10:00:01.000Z',
				bytes: Uint8Array.from([1]).buffer,
				cueCount: 1,
				etag: '"tcap-old"',
				fileLength: 100,
				formatVersion: 1,
				ih: INFO_HASH,
				path,
				updatedAt: 100,
			})
			const observed = await repository.getCaptionTrack(INFO_HASH, path)
			if (!observed) {
				throw new Error('Expected the first caption record to be stored')
			}
			await repository.putCaptionTrack({
				artifactUpdatedAt: '2026-09-04T10:00:02.000Z',
				bytes: Uint8Array.from([2]).buffer,
				cueCount: 1,
				etag: '"tcap-replacement"',
				fileLength: 100,
				formatVersion: 1,
				ih: INFO_HASH,
				path,
				updatedAt: 200,
			})

			expect(
				await repository.removeCaptionTrack(INFO_HASH, path, {
					artifactUpdatedAt: observed.artifactUpdatedAt,
					etag: observed.etag,
					updatedAt: observed.updatedAt,
				})
			).toBe(false)
			const replacement = await repository.getCaptionTrack(INFO_HASH, path)
			if (!replacement) {
				throw new Error('Expected the replacement caption record to remain')
			}
			expect(
				await repository.removeCaptionTrack(INFO_HASH, path, {
					artifactUpdatedAt: replacement.artifactUpdatedAt,
					etag: '"wrong-etag"',
					updatedAt: replacement.updatedAt,
				})
			).toBe(false)
			expect(
				await repository.removeCaptionTrack(INFO_HASH, path, {
					artifactUpdatedAt: '2026-09-04T10:00:03.000Z',
					etag: replacement.etag,
					updatedAt: replacement.updatedAt,
				})
			).toBe(false)
			expect(
				await repository.removeCaptionTrack(INFO_HASH, path, {
					artifactUpdatedAt: replacement.artifactUpdatedAt,
					etag: replacement.etag,
					updatedAt: replacement.updatedAt + 1,
				})
			).toBe(false)
			expect(
				await repository.removeCaptionTrack(INFO_HASH, path, {
					artifactUpdatedAt: replacement.artifactUpdatedAt,
					etag: replacement.etag,
					updatedAt: replacement.updatedAt,
				})
			).toBe(true)
			expect(await repository.getCaptionTrack(INFO_HASH, path)).toBeNull()
		} finally {
			await repository.deleteDatabase()
		}
	})

	test('does not let a delayed older caption write replace a newer track', async () => {
		const databaseName = uniqueDatabaseName('caption-write-order')
		const repository = createRepository(databaseName)
		const path = 'Caption race/01.mp3'
		try {
			await repository.addTorrent(INFO_HASH, { name: 'Caption race' })
			await repository.putCaptionTrack({
				bytes: Uint8Array.from([2]).buffer,
				cueCount: 1,
				etag: '"tcap-newer"',
				fileLength: 100,
				formatVersion: 1,
				ih: INFO_HASH,
				path,
				updatedAt: 200,
			})
			await repository.putCaptionTrack({
				bytes: Uint8Array.from([1]).buffer,
				cueCount: 1,
				etag: '"tcap-older"',
				fileLength: 100,
				formatVersion: 1,
				ih: INFO_HASH,
				path,
				updatedAt: 100,
			})

			const stored = await repository.getCaptionTrack(INFO_HASH, path)
			expect(stored?.etag).toBe('"tcap-newer"')
			expect(new Uint8Array(stored?.bytes ?? new ArrayBuffer(0))).toEqual(
				Uint8Array.from([2])
			)
		} finally {
			await repository.deleteDatabase()
		}
	})

	test('commits out-of-order chunks exactly once and assembles the exact large file', async () => {
		const databaseName = uniqueDatabaseName('chunked-file')
		const repository = createRepository(databaseName)
		const path = 'Chunked/01.m4b'
		const bytes = deterministicBytes(TEST_CHUNK_BYTES * 2 + 12_345)
		try {
			await repository.prepareFileDownload(
				INFO_HASH,
				path,
				bytes.byteLength,
				'audio/mp4',
				TEST_CHUNK_BYTES
			)
			for (const index of [2, 0, 1, 1]) {
				const start = index * TEST_CHUNK_BYTES
				const end = Math.min(bytes.byteLength - 1, start + TEST_CHUNK_BYTES - 1)
				// biome-ignore lint/performance/noAwaitInLoops: Ordered assertions verify every durable transaction result.
				const state = await repository.putFileChunk({
					chunkSize: TEST_CHUNK_BYTES,
					data: new Blob([bytes.slice(start, end + 1)], { type: 'audio/mp4' }),
					end,
					generation: 0,
					ih: INFO_HASH,
					index,
					length: bytes.byteLength,
					mimeType: 'audio/mp4',
					path,
					start,
					validator: '"storage-test-validator"',
				})
				expect(state.downloadedBytes).toBeLessThanOrEqual(bytes.byteLength)
			}

			const completed = await repository.completeFileDownload(INFO_HASH, path)
			expect(completed).toEqual({
				complete: true,
				downloadedBytes: bytes.byteLength,
				generation: 0,
				length: bytes.byteLength,
				mimeType: 'audio/mp4',
				path,
				validator: '"storage-test-validator"',
			})
			const reconstructed = await repository.getFileBlob(INFO_HASH, path)
			expect(reconstructed?.size).toBe(bytes.byteLength)
			expect(await exactBytes(reconstructed ?? new Blob())).toEqual(bytes)
			expect(
				await repository.getStoredFileChunkIndexes(INFO_HASH, path)
			).toEqual(new Set([0, 1, 2]))
		} finally {
			await repository.deleteDatabase()
		}
	})

	test('a cross-tab clear invalidates late writes atomically and a remove tombstone blocks stale tabs', async () => {
		const databaseName = uniqueDatabaseName('cross-tab-generation')
		const firstTab = createRepository(databaseName)
		const secondTab = createRepository(databaseName)
		const path = 'Concurrent/01.m4b'
		const bytes = deterministicBytes(TEST_CHUNK_BYTES * 2)
		try {
			await firstTab.addTorrent(INFO_HASH, { name: 'Concurrent book' })
			const noteId = await firstTab.addNote(
				INFO_HASH,
				path,
				42,
				'Keep after clear'
			)
			const generation = await firstTab.getOfflineGeneration(INFO_HASH)
			await firstTab.prepareFileDownload(
				INFO_HASH,
				path,
				bytes.byteLength,
				'audio/mp4',
				TEST_CHUNK_BYTES,
				generation
			)
			await firstTab.putFileChunk({
				chunkSize: TEST_CHUNK_BYTES,
				data: new Blob([bytes.slice(0, TEST_CHUNK_BYTES)]),
				end: TEST_CHUNK_BYTES - 1,
				generation,
				ih: INFO_HASH,
				index: 0,
				length: bytes.byteLength,
				mimeType: 'audio/mp4',
				path,
				start: 0,
				validator: '"cross-tab-validator"',
			})

			expect(await secondTab.removeFilesByIh(INFO_HASH)).toBe(true)
			await expect(
				firstTab.putFileChunk({
					chunkSize: TEST_CHUNK_BYTES,
					data: new Blob([bytes.slice(TEST_CHUNK_BYTES)]),
					end: bytes.byteLength - 1,
					generation,
					ih: INFO_HASH,
					index: 1,
					length: bytes.byteLength,
					mimeType: 'audio/mp4',
					path,
					start: TEST_CHUNK_BYTES,
					validator: '"cross-tab-validator"',
				})
			).rejects.toMatchObject({ name: 'AbortError' })
			await expect(
				firstTab.completeFileDownload(INFO_HASH, path, generation)
			).rejects.toMatchObject({ name: 'AbortError' })
			expect(await firstTab.getOfflineFileState(INFO_HASH, path)).toBeNull()
			expect(await firstTab.getStoredFileChunkIndexes(INFO_HASH, path)).toEqual(
				new Set()
			)
			expect((await firstTab.getTorrent(INFO_HASH))?.info).toEqual({
				name: 'Concurrent book',
			})
			expect((await firstTab.getNote(noteId))?.note).toBe('Keep after clear')

			expect(await secondTab.removeFilesAndTorrent(INFO_HASH)).toBe(true)
			await expect(
				firstTab.getOfflineGeneration(INFO_HASH)
			).rejects.toMatchObject({
				name: 'AbortError',
			})
			await firstTab.addTorrent(INFO_HASH, { name: 'Re-added book' })
			expect(await firstTab.getOfflineGeneration(INFO_HASH)).toBeGreaterThan(
				generation
			)
		} finally {
			secondTab.close()
			await firstTab.deleteDatabase()
		}
	})

	test('cross-tab offline leases exclude a second owner and allow release or expiry takeover', async () => {
		const databaseName = uniqueDatabaseName('offline-leases')
		const firstTab = createRepository(databaseName)
		const secondTab = createRepository(databaseName)
		const leaseName = 'offline:file:chapter-01'
		try {
			expect(
				await firstTab.tryAcquireOfflineLease(leaseName, 'first', 1000, 2000)
			).toBe(true)
			expect(
				await secondTab.tryAcquireOfflineLease(leaseName, 'second', 1500, 2500)
			).toBe(false)
			expect(await secondTab.renewOfflineLease(leaseName, 'second', 3000)).toBe(
				false
			)
			expect(await firstTab.renewOfflineLease(leaseName, 'first', 3000)).toBe(
				true
			)

			await secondTab.releaseOfflineLease(leaseName, 'second')
			expect(
				await secondTab.tryAcquireOfflineLease(leaseName, 'second', 2500, 3500)
			).toBe(false)
			await firstTab.releaseOfflineLease(leaseName, 'first')
			expect(
				await secondTab.tryAcquireOfflineLease(leaseName, 'second', 2500, 3500)
			).toBe(true)

			expect(
				await firstTab.tryAcquireOfflineLease(leaseName, 'first', 4000, 5000)
			).toBe(true)
		} finally {
			secondTab.close()
			await firstTab.deleteDatabase()
		}
	})

	test('stale partial cleanup removes at most one exact 1 MiB chunk per bounded pass', async () => {
		const databaseName = uniqueDatabaseName('stale-partials')
		const repository = createRepository(databaseName)
		const path = 'Stale/01.m4b'
		const bytes = deterministicBytes(TEST_CHUNK_BYTES * 2)
		try {
			await repository.prepareFileDownload(
				INFO_HASH,
				path,
				bytes.byteLength,
				'audio/mp4',
				TEST_CHUNK_BYTES
			)
			for (const index of [0, 1]) {
				const start = index * TEST_CHUNK_BYTES
				// biome-ignore lint/performance/noAwaitInLoops: The fixture creates two durable chunks before bounded cleanup.
				await repository.putFileChunk({
					chunkSize: TEST_CHUNK_BYTES,
					data: new Blob([bytes.slice(start, start + TEST_CHUNK_BYTES)]),
					end: start + TEST_CHUNK_BYTES - 1,
					generation: 0,
					ih: INFO_HASH,
					index,
					length: bytes.byteLength,
					mimeType: 'audio/mp4',
					path,
					start,
					validator: '"stale-validator"',
				})
			}

			const firstPass = await repository.cleanupStalePartialDownloads({
				cutoffUpdatedAt: Date.now() + 1000,
				maxChunks: 1,
				maxDownloads: 1,
			})
			expect(firstPass).toEqual({
				deletedBytes: TEST_CHUNK_BYTES,
				deletedChunks: 1,
				deletedDownloads: 0,
				hasMore: true,
			})
			expect(
				(await repository.getOfflineFileState(INFO_HASH, path))?.downloadedBytes
			).toBe(TEST_CHUNK_BYTES)

			const secondPass = await repository.cleanupStalePartialDownloads({
				cutoffUpdatedAt: Date.now() + 1000,
				maxChunks: 1,
				maxDownloads: 1,
			})
			expect(secondPass).toEqual({
				deletedBytes: TEST_CHUNK_BYTES,
				deletedChunks: 1,
				deletedDownloads: 1,
				hasMore: false,
			})
			expect(await repository.getOfflineFileState(INFO_HASH, path)).toBeNull()
		} finally {
			await repository.deleteDatabase()
		}
	})

	test('returns every saved torrent in measured recency order beyond the legacy five-item cap', async () => {
		const databaseName = uniqueDatabaseName('recency')
		const repository = createRepository(databaseName)
		const recency = [14, 81, 3, 55, 34, 89, 21, 67]
		try {
			await Promise.all(
				recency.map(async (updatedAt, index) => {
					const infoHash = index.toString(16).padStart(40, '0')
					await repository.addTorrent(infoHash, { name: `Book ${index}` })
					await repository.updateTorrent(infoHash, {
						state: {
							path: [`Book ${index}.mp3`],
							time: index * 10,
							updatedAt,
						},
					})
				})
			)

			const expectedHashes = recency
				.map((updatedAt, index) => ({
					infoHash: index.toString(16).padStart(40, '0'),
					updatedAt,
				}))
				.sort((left, right) => right.updatedAt - left.updatedAt)
				.map(({ infoHash }) => infoHash)
			const all = await repository.getTorrents()
			expect(all).toHaveLength(recency.length)
			expect(all.map(({ ih }) => ih)).toEqual(expectedHashes)
			expect((await repository.getTorrents(3)).map(({ ih }) => ih)).toEqual(
				expectedHashes.slice(0, 3)
			)
		} finally {
			await repository.deleteDatabase()
		}
	})

	test('clean removes only offline bytes while remove atomically clears files, notes, and playback state', async () => {
		const databaseName = uniqueDatabaseName('clean-remove')
		const repository = createRepository(databaseName)
		try {
			await repository.addTorrent(INFO_HASH, { name: 'Persistent book' })
			await repository.updateTorrent(INFO_HASH, {
				state: {
					path: ['Persistent book', '01.mp3'],
					time: 945.5,
					updatedAt: 99,
				},
			})
			const noteId = await repository.addNote(
				INFO_HASH,
				'Persistent book/01.mp3',
				900,
				'Important passage'
			)
			await repository.addFile(
				INFO_HASH,
				'Persistent book/01.mp3',
				new Blob([Uint8Array.from([1, 3, 3, 7])])
			)
			await repository.prepareFileDownload(
				INFO_HASH,
				'Persistent book/02.mp3',
				TEST_CHUNK_BYTES * 2,
				'audio/mpeg',
				TEST_CHUNK_BYTES
			)
			await repository.putFileChunk({
				chunkSize: TEST_CHUNK_BYTES,
				data: new Blob([deterministicBytes(TEST_CHUNK_BYTES)]),
				end: TEST_CHUNK_BYTES - 1,
				generation: 0,
				ih: INFO_HASH,
				index: 0,
				length: TEST_CHUNK_BYTES * 2,
				mimeType: 'audio/mpeg',
				path: 'Persistent book/02.mp3',
				start: 0,
				validator: '"cleanup-test-validator"',
			})
			await repository.putCaptionTrack({
				bytes: Uint8Array.from([1, 2, 3]).buffer,
				cueCount: 1,
				etag: '"caption-cleanup"',
				fileLength: 4,
				formatVersion: 1,
				ih: INFO_HASH,
				path: 'Persistent book/01.mp3',
				updatedAt: 100,
			})

			expect(await repository.removeFilesByIh(INFO_HASH)).toBe(true)
			expect(await repository.getAllFilesForTorrent(INFO_HASH)).toEqual([])
			expect(
				await repository.getOfflineFileStatesForTorrent(INFO_HASH)
			).toEqual([])
			expect((await repository.getTorrent(INFO_HASH))?.state).toEqual({
				path: ['Persistent book', '01.mp3'],
				time: 945.5,
				updatedAt: 99,
			})
			expect((await repository.getNote(noteId))?.note).toBe('Important passage')
			expect(
				await repository.getCaptionTrack(INFO_HASH, 'Persistent book/01.mp3')
			).not.toBeNull()

			await repository.addFile(
				INFO_HASH,
				'Persistent book/01.mp3',
				new Blob([Uint8Array.from([2, 4, 6, 8])])
			)
			expect(await repository.removeFilesAndTorrent(INFO_HASH)).toBe(true)
			expect(await repository.getTorrent(INFO_HASH)).toBeNull()
			expect(await repository.getAllFilesForTorrent(INFO_HASH)).toEqual([])
			expect(await repository.getNote(noteId)).toBeUndefined()
			expect(await repository.getCaptionTracksForTorrent(INFO_HASH)).toEqual([])
			await expect(
				repository.putCaptionTrack({
					bytes: Uint8Array.from([9]).buffer,
					cueCount: 1,
					etag: '"late-caption"',
					fileLength: 4,
					formatVersion: 1,
					ih: INFO_HASH,
					path: 'Persistent book/01.mp3',
					updatedAt: 101,
				})
			).rejects.toMatchObject({ name: 'AbortError' })
		} finally {
			await repository.deleteDatabase()
		}
	})
})

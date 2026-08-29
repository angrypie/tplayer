/// <reference types="bun" />

import { describe, expect, test } from 'bun:test'
import Dexie from 'dexie'
import { IDBKeyRange, indexedDB } from 'fake-indexeddb'
import { type BookStorage, createStorage } from './index'

const INFO_HASH = '0123456789abcdef0123456789abcdef01234567'
const LEGACY_COMBINED_PATH = 'combined_Joh1thoh/0-1/Migrated audiobook/01.mp3'

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
			expect(combined?.file.type).toBe('audio/mpeg')
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
			expect(storedFiles[0]?.file.type).toBe('audio/mpeg')
			expect(await exactBytes(storedFiles[0]?.file ?? new Blob())).toEqual(
				bytes
			)
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

			expect(await repository.removeFilesByIh(INFO_HASH)).toBe(true)
			expect(await repository.getAllFilesForTorrent(INFO_HASH)).toEqual([])
			expect((await repository.getTorrent(INFO_HASH))?.state).toEqual({
				path: ['Persistent book', '01.mp3'],
				time: 945.5,
				updatedAt: 99,
			})
			expect((await repository.getNote(noteId))?.note).toBe('Important passage')

			await repository.addFile(
				INFO_HASH,
				'Persistent book/01.mp3',
				new Blob([Uint8Array.from([2, 4, 6, 8])])
			)
			expect(await repository.removeFilesAndTorrent(INFO_HASH)).toBe(true)
			expect(await repository.getTorrent(INFO_HASH)).toBeNull()
			expect(await repository.getAllFilesForTorrent(INFO_HASH)).toEqual([])
			expect(await repository.getNote(noteId)).toBeUndefined()
		} finally {
			await repository.deleteDatabase()
		}
	})
})

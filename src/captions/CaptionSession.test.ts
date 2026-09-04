import { describe, expect, test } from 'bun:test'
import { encodeCaptionTrack } from '@tplayer/captions/codec'
import type { StoredCaptionTrack } from '~/storage'
import {
	CaptionApiError,
	type TranscriptionState,
	type TranscriptionStatus,
} from './api'
import {
	type CaptionService,
	CaptionSession,
	type CaptionTarget,
} from './CaptionSession'

const INFO_HASH = '0123456789abcdef0123456789abcdef01234567'
const CREATED_AT = '2026-09-04T10:00:00.000Z'
const ARTIFACT_UPDATED_AT = '2026-09-04T10:00:01.000Z'
const UPDATED_AT = '2026-09-04T10:00:02.000Z'

const TARGET: CaptionTarget = {
	fileId: '7',
	fileLength: 42,
	infoHash: INFO_HASH,
	path: ['Book', '01.mp3'],
}

const encodeTrack = (prefix: string): ArrayBuffer => {
	const bytes = encodeCaptionTrack({
		durationMs: 2500,
		segments: [
			{ endMs: 1000, startMs: 0, text: `${prefix} first` },
			{ endMs: 2200, startMs: 1200, text: `${prefix} second` },
		],
	})
	return bytes.buffer.slice(
		bytes.byteOffset,
		bytes.byteOffset + bytes.byteLength
	) as ArrayBuffer
}

const createStatus = (
	state: TranscriptionState,
	target: CaptionTarget = TARGET,
	overrides: Partial<TranscriptionStatus> = {}
): TranscriptionStatus => ({
	attempt: 1,
	createdAt: CREATED_AT,
	fileId: target.fileId,
	fileLength: target.fileLength,
	infoHash: target.infoHash,
	path: [...target.path],
	processedMilliseconds: state === 'completed' ? 2500 : 0,
	state,
	trigger: 'manual',
	updatedAt: UPDATED_AT,
	...overrides,
})

const createCompletedStatus = (
	target: CaptionTarget,
	etag: string,
	byteLength: number
): TranscriptionStatus =>
	createStatus('completed', target, {
		captions: {
			byteLength,
			cueCount: 2,
			durationMilliseconds: 2500,
			etag,
			formatVersion: 1,
			language: 'en',
			updatedAt: ARTIFACT_UPDATED_AT,
			url: `/api/torrents/${target.infoHash}/files/${target.fileId}/captions`,
		},
	})

const createMemoryRepository = (initial?: StoredCaptionTrack) => {
	const records = new Map<string, StoredCaptionTrack>()
	if (initial) {
		records.set(`${initial.ih}\0${initial.path}`, initial)
	}
	const key = (infoHash: string, path: string): string =>
		`${infoHash.toLowerCase()}\0${path}`
	const shouldKeepCurrent = (
		current: StoredCaptionTrack,
		incoming: StoredCaptionTrack
	): boolean => {
		const currentArtifactTime = current.artifactUpdatedAt
			? Date.parse(current.artifactUpdatedAt)
			: Number.NaN
		const incomingArtifactTime = incoming.artifactUpdatedAt
			? Date.parse(incoming.artifactUpdatedAt)
			: Number.NaN
		if (Number.isFinite(currentArtifactTime)) {
			if (!Number.isFinite(incomingArtifactTime)) {
				return true
			}
			return (
				currentArtifactTime > incomingArtifactTime ||
				(currentArtifactTime === incomingArtifactTime &&
					current.etag !== incoming.etag)
			)
		}
		if (Number.isFinite(incomingArtifactTime)) {
			return false
		}
		return current.updatedAt > incoming.updatedAt
	}
	return {
		getStored: (target: CaptionTarget): StoredCaptionTrack | undefined =>
			records.get(key(target.infoHash, target.path.join('/'))),
		repository: {
			getCaptionTrack: (infoHash: string, path: string) =>
				Promise.resolve(records.get(key(infoHash, path)) ?? null),
			putCaptionTrack: (record: StoredCaptionTrack) => {
				const recordKey = key(record.ih, record.path)
				const current = records.get(recordKey)
				if (!(current && shouldKeepCurrent(current, record))) {
					records.set(recordKey, record)
				}
				return Promise.resolve()
			},
			removeCaptionTrack: (
				infoHash: string,
				path: string,
				expected?: Pick<
					StoredCaptionTrack,
					'artifactUpdatedAt' | 'etag' | 'updatedAt'
				>
			) => {
				const recordKey = key(infoHash, path)
				const current = records.get(recordKey)
				if (
					current &&
					(!expected ||
						(current.artifactUpdatedAt === expected.artifactUpdatedAt &&
							current.etag === expected.etag &&
							current.updatedAt === expected.updatedAt))
				) {
					records.delete(recordKey)
					return Promise.resolve(true)
				}
				return Promise.resolve(false)
			},
		},
	}
}

const unavailableService = (onCall: () => void): CaptionService => ({
	cancel: () => {
		onCall()
		return Promise.resolve()
	},
	getStatus: () => {
		onCall()
		return Promise.resolve(null)
	},
	getTrack: () => {
		onCall()
		return Promise.resolve({ kind: 'missing' })
	},
	start: () => {
		onCall()
		return Promise.resolve(createStatus('queued'))
	},
})

const waitForSessionSnapshot = async (
	session: CaptionSession,
	predicate: (snapshot: ReturnType<CaptionSession['getSnapshot']>) => boolean
): Promise<ReturnType<CaptionSession['getSnapshot']>> =>
	await new Promise((resolve, reject) => {
		let unsubscribe = (): void => undefined
		const timeout = setTimeout(() => {
			unsubscribe()
			reject(new Error('Timed out waiting for caption session state'))
		}, 1000)
		const inspect = (): void => {
			const snapshot = session.getSnapshot()
			if (!predicate(snapshot)) {
				return
			}
			clearTimeout(timeout)
			unsubscribe()
			resolve(snapshot)
		}
		unsubscribe = session.subscribe(inspect)
		inspect()
	})

describe('caption session', () => {
	test('hydrates cached TCAP first and seeks without touching the server', async () => {
		const bytes = encodeTrack('Cached')
		const memory = createMemoryRepository({
			bytes,
			cueCount: 2,
			durationMilliseconds: 2500,
			etag: '"tcap1-cached"',
			fileLength: TARGET.fileLength,
			formatVersion: 1,
			ih: INFO_HASH,
			language: 'en',
			path: TARGET.path.join('/'),
			updatedAt: 1,
		})
		let networkCalls = 0
		const session = new CaptionSession({
			api: unavailableService(() => {
				networkCalls += 1
			}),
			repository: memory.repository,
		})

		await session.activate(TARGET, false)

		expect(session.getSnapshot()).toEqual({
			cached: true,
			phase: 'ready',
			status: null,
		})
		expect(networkCalls).toBe(0)
		expect(session.seek(0)).toBe(0)
		expect(session.textAt(0)).toBe('Cached first')
		expect(session.seek(1100)).toBe(-1)
		expect(session.seek(1500)).toBe(1)
		expect(session.textAt(1)).toBe('Cached second')
		session.dispose()
	})

	test('downloads, decodes, and stores the exact completed TCAP response', async () => {
		const bytes = encodeTrack('Server')
		const etag = '"tcap1-server"'
		const memory = createMemoryRepository()
		let conditionalEtag: string | undefined
		const api: CaptionService = {
			cancel: () => Promise.resolve(),
			getStatus: () =>
				Promise.resolve(createCompletedStatus(TARGET, etag, bytes.byteLength)),
			getTrack: (_infoHash, _fileId, requestedEtag) => {
				conditionalEtag = requestedEtag
				return Promise.resolve({
					artifactUpdatedAt: ARTIFACT_UPDATED_AT,
					bytes,
					etag,
					kind: 'track',
				})
			},
			start: () => Promise.resolve(createStatus('queued')),
		}
		const session = new CaptionSession({ api, repository: memory.repository })

		await session.activate(TARGET, true)

		expect(conditionalEtag).toBeUndefined()
		expect(session.getSnapshot()).toMatchObject({
			cached: true,
			phase: 'ready',
		})
		expect(session.seek(1250)).toBe(1)
		expect(session.textAt(1)).toBe('Server second')
		const stored = memory.getStored(TARGET)
		expect(stored).toMatchObject({
			cueCount: 2,
			durationMilliseconds: 2500,
			etag,
			fileLength: TARGET.fileLength,
			formatVersion: 1,
			language: 'en',
		})
		expect(new Uint8Array(stored?.bytes ?? new ArrayBuffer(0))).toEqual(
			new Uint8Array(bytes)
		)
		session.dispose()
	})

	test('keeps downloaded captions usable when IndexedDB persistence fails', async () => {
		const bytes = encodeTrack('Memory only')
		const etag = '"tcap1-memory-only"'
		const api: CaptionService = {
			cancel: () => Promise.resolve(),
			getStatus: () =>
				Promise.resolve(createCompletedStatus(TARGET, etag, bytes.byteLength)),
			getTrack: () =>
				Promise.resolve({
					artifactUpdatedAt: ARTIFACT_UPDATED_AT,
					bytes,
					etag,
					kind: 'track',
				}),
			start: () => Promise.resolve(createStatus('queued')),
		}
		const session = new CaptionSession({
			api,
			repository: {
				getCaptionTrack: () => Promise.resolve(null),
				putCaptionTrack: () =>
					Promise.reject(new Error('IndexedDB quota exceeded')),
				removeCaptionTrack: () => Promise.resolve(true),
			},
		})

		await session.activate(TARGET, true)

		expect(session.getSnapshot()).toMatchObject({
			cached: false,
			message: 'Captions are available but could not be saved offline.',
			phase: 'ready',
		})
		expect(session.textAt(session.seek(0))).toBe('Memory only first')
		session.dispose()
	})

	test('aborts and ignores stale work when the playback source changes', async () => {
		const firstTarget: CaptionTarget = { ...TARGET, fileId: '1' }
		const secondTarget: CaptionTarget = {
			...TARGET,
			fileId: '2',
			path: ['Book', '02.mp3'],
		}
		const firstBytes = encodeTrack('First')
		const secondBytes = encodeTrack('Second')
		const memory = createMemoryRepository()
		let firstSignal: AbortSignal | undefined
		let announceFirstStatus: (() => void) | undefined
		const firstStatusStarted = new Promise<void>((resolve) => {
			announceFirstStatus = resolve
		})
		let resolveFirstStatus:
			| ((status: TranscriptionStatus | null) => void)
			| undefined
		const pendingFirstStatus = new Promise<TranscriptionStatus | null>(
			(resolve) => {
				resolveFirstStatus = resolve
			}
		)
		const downloadedFileIds: string[] = []
		const api: CaptionService = {
			cancel: () => Promise.resolve(),
			getStatus: (_infoHash, fileId, signal) => {
				if (fileId === firstTarget.fileId) {
					firstSignal = signal
					announceFirstStatus?.()
					return pendingFirstStatus
				}
				return Promise.resolve(
					createCompletedStatus(
						secondTarget,
						'"tcap1-second"',
						secondBytes.byteLength
					)
				)
			},
			getTrack: (_infoHash, fileId) => {
				downloadedFileIds.push(fileId)
				const selectedBytes =
					fileId === firstTarget.fileId ? firstBytes : secondBytes
				return Promise.resolve({
					artifactUpdatedAt: ARTIFACT_UPDATED_AT,
					bytes: selectedBytes,
					etag: `"tcap1-${fileId}"`,
					kind: 'track',
				})
			},
			start: () => Promise.resolve(createStatus('queued')),
		}
		const session = new CaptionSession({ api, repository: memory.repository })

		const firstActivation = session.activate(firstTarget, true)
		await firstStatusStarted
		await session.activate(secondTarget, true)
		resolveFirstStatus?.(
			createCompletedStatus(firstTarget, '"tcap1-first"', firstBytes.byteLength)
		)
		await firstActivation
		await new Promise((resolve) => setTimeout(resolve, 0))
		await session.checkStatus()

		expect(firstSignal?.aborted).toBe(true)
		expect(downloadedFileIds).toEqual([secondTarget.fileId])
		expect(session.seek(0)).toBe(0)
		expect(session.textAt(0)).toBe('Second first')
		expect(memory.getStored(firstTarget)).toBeUndefined()
		expect(memory.getStored(secondTarget)?.etag).toBe('"tcap1-2"')
		session.dispose()
	})

	test('adopts a matching cross-tab record without an unnecessary transfer', async () => {
		const firstBytes = encodeTrack('Installed A')
		const secondBytes = encodeTrack('Server B')
		const firstRecord: StoredCaptionTrack = {
			bytes: firstBytes,
			cueCount: 2,
			etag: '"tcap1-a"',
			fileLength: TARGET.fileLength,
			formatVersion: 1,
			ih: TARGET.infoHash,
			path: TARGET.path.join('/'),
			updatedAt: 1,
		}
		const memory = createMemoryRepository(firstRecord)
		let announceStatus: (() => void) | undefined
		const statusStarted = new Promise<void>((resolve) => {
			announceStatus = resolve
		})
		let resolveStatus: ((status: TranscriptionStatus) => void) | undefined
		const pendingStatus = new Promise<TranscriptionStatus>((resolve) => {
			resolveStatus = resolve
		})
		let conditionalEtag: string | undefined
		const api: CaptionService = {
			cancel: () => Promise.resolve(),
			getStatus: () => {
				announceStatus?.()
				return pendingStatus
			},
			getTrack: (_infoHash, _fileId, requestedEtag) => {
				conditionalEtag = requestedEtag
				return Promise.resolve({
					artifactUpdatedAt: ARTIFACT_UPDATED_AT,
					bytes: secondBytes,
					etag: '"tcap1-b"',
					kind: 'track',
				})
			},
			start: () => Promise.resolve(createStatus('queued')),
		}
		const session = new CaptionSession({ api, repository: memory.repository })

		const activation = session.activate(TARGET, true)
		await statusStarted
		await memory.repository.putCaptionTrack({
			...firstRecord,
			bytes: secondBytes,
			etag: '"tcap1-b"',
			updatedAt: 2,
		})
		resolveStatus?.(
			createCompletedStatus(TARGET, '"tcap1-b"', secondBytes.byteLength)
		)
		await activation

		expect(conditionalEtag).toBeUndefined()
		expect(session.textAt(session.seek(0))).toBe('Server B first')
		expect(memory.getStored(TARGET)?.etag).toBe('"tcap1-b"')
		session.dispose()
	})

	test('hydrates a prior server artifact during running and terminal refresh states', async () => {
		const bytes = encodeTrack('Prior server')
		const { captions } = createCompletedStatus(
			TARGET,
			'"tcap1-prior"',
			bytes.byteLength
		)
		if (!captions) {
			throw new Error('Completed fixture omitted caption metadata')
		}
		const cases: Array<{
			message: string
			state: Extract<TranscriptionState, 'cancelled' | 'failed' | 'queued'>
		}> = [
			{
				message:
					'Saved captions are shown while a refreshed track is prepared.',
				state: 'queued',
			},
			{
				message:
					'Saved captions are shown; refresh failed. Refresh failed safely.',
				state: 'failed',
			},
			{
				message: 'Saved captions are shown; refresh was cancelled.',
				state: 'cancelled',
			},
		]

		await Promise.all(
			cases.map(async ({ message, state }) => {
				const memory = createMemoryRepository()
				let trackCalls = 0
				const status = createStatus(state, TARGET, {
					captions,
					...(state === 'failed'
						? {
								error: {
									ambiguous: false,
									code: 'refresh_failed',
									message: 'Refresh failed safely.',
									retryable: true,
								},
							}
						: {}),
				})
				const api: CaptionService = {
					cancel: () => Promise.resolve(),
					getStatus: () => Promise.resolve(status),
					getTrack: () => {
						trackCalls += 1
						return Promise.resolve({
							artifactUpdatedAt: ARTIFACT_UPDATED_AT,
							bytes,
							etag: captions.etag,
							kind: 'track',
						})
					},
					start: () => Promise.resolve(createStatus('queued')),
				}
				const session = new CaptionSession({
					api,
					repository: memory.repository,
				})

				await session.activate(TARGET, true)

				expect(trackCalls).toBe(1)
				expect(session.getSnapshot()).toMatchObject({
					cached: true,
					message,
					phase: 'ready',
					status: { state },
				})
				expect(session.textAt(session.seek(0))).toBe('Prior server first')
				expect(memory.getStored(TARGET)?.etag).toBe(captions.etag)
				session.dispose()
			})
		)
	})

	test('replaces stale cached captions with the prior server artifact in every refresh state', async () => {
		const cachedBytes = encodeTrack('Cached A')
		const serverBytes = encodeTrack('Server B')
		const { captions } = createCompletedStatus(
			TARGET,
			'"tcap1-b"',
			serverBytes.byteLength
		)
		if (!captions) {
			throw new Error('Completed fixture omitted caption metadata')
		}
		const states: Extract<
			TranscriptionState,
			'cancelled' | 'failed' | 'queued'
		>[] = ['queued', 'failed', 'cancelled']

		await Promise.all(
			states.map(async (state) => {
				const memory = createMemoryRepository({
					artifactUpdatedAt: '2026-09-04T09:59:59.000Z',
					bytes: cachedBytes,
					cueCount: 2,
					etag: '"tcap1-a"',
					fileLength: TARGET.fileLength,
					formatVersion: 1,
					ih: INFO_HASH,
					path: TARGET.path.join('/'),
					updatedAt: 1,
				})
				let trackCalls = 0
				const status = createStatus(state, TARGET, {
					captions,
					...(state === 'failed'
						? {
								error: {
									ambiguous: false,
									code: 'refresh_failed',
									message: 'Refresh failed safely.',
									retryable: true,
								},
							}
						: {}),
				})
				const api: CaptionService = {
					cancel: () => Promise.resolve(),
					getStatus: () => Promise.resolve(status),
					getTrack: () => {
						trackCalls += 1
						return Promise.resolve({
							artifactUpdatedAt: captions.updatedAt,
							bytes: serverBytes,
							etag: captions.etag,
							kind: 'track',
						})
					},
					start: () => Promise.resolve(createStatus('queued')),
				}
				const session = new CaptionSession({
					api,
					repository: memory.repository,
				})

				await session.activate(TARGET, true)

				expect(trackCalls).toBe(1)
				expect(session.getSnapshot()).toMatchObject({
					cached: true,
					phase: 'ready',
					status: { state },
				})
				expect(session.textAt(session.seek(0))).toBe('Server B first')
				expect(memory.getStored(TARGET)?.etag).toBe(captions.etag)
				session.dispose()
			})
		)
	})

	test('keeps cached captions and refresh state when a newer artifact cannot be fetched', async () => {
		const cachedBytes = encodeTrack('Cached A')
		const { captions } = createCompletedStatus(
			TARGET,
			'"tcap1-b"',
			cachedBytes.byteLength
		)
		if (!captions) {
			throw new Error('Completed fixture omitted caption metadata')
		}
		const memory = createMemoryRepository({
			artifactUpdatedAt: '2026-09-04T09:59:59.000Z',
			bytes: cachedBytes,
			cueCount: 2,
			etag: '"tcap1-a"',
			fileLength: TARGET.fileLength,
			formatVersion: 1,
			ih: INFO_HASH,
			path: TARGET.path.join('/'),
			updatedAt: 1,
		})
		const queued = createStatus('queued', TARGET, { captions })
		const api: CaptionService = {
			cancel: () => Promise.resolve(),
			getStatus: () => Promise.resolve(queued),
			getTrack: () => Promise.reject(new Error('temporary download failure')),
			start: () => Promise.resolve(createStatus('queued')),
		}
		const session = new CaptionSession({ api, repository: memory.repository })

		await session.activate(TARGET, true)

		expect(session.getSnapshot()).toMatchObject({
			cached: true,
			phase: 'ready',
			status: { state: 'queued' },
		})
		expect(session.textAt(session.seek(0))).toBe('Cached A first')
		session.dispose()
	})

	test('resumes polling after a transient error and discovers completed captions', async () => {
		const cachedBytes = encodeTrack('Cached A')
		const completedBytes = encodeTrack('Completed B')
		const completed = createCompletedStatus(
			TARGET,
			'"tcap1-completed-b"',
			completedBytes.byteLength
		)
		const memory = createMemoryRepository({
			artifactUpdatedAt: '2026-09-04T09:59:59.000Z',
			bytes: cachedBytes,
			cueCount: 2,
			durationMilliseconds: 2500,
			etag: '"tcap1-cached-a"',
			fileLength: TARGET.fileLength,
			formatVersion: 1,
			ih: INFO_HASH,
			path: TARGET.path.join('/'),
			updatedAt: 1,
		})
		let statusCalls = 0
		let trackCalls = 0
		const session = new CaptionSession({
			api: {
				cancel: () => Promise.resolve(),
				getStatus: () => {
					statusCalls += 1
					if (statusCalls === 1) {
						return Promise.resolve(createStatus('queued'))
					}
					if (statusCalls === 2) {
						return Promise.reject(new Error('temporary polling failure'))
					}
					return Promise.resolve(completed)
				},
				getTrack: () => {
					trackCalls += 1
					return Promise.resolve({
						artifactUpdatedAt: ARTIFACT_UPDATED_AT,
						bytes: completedBytes,
						etag: '"tcap1-completed-b"',
						kind: 'track',
					})
				},
				start: () => Promise.resolve(createStatus('queued')),
			},
			pollIntervalMs: 50,
			repository: memory.repository,
		})
		const reachedCompleted = new Promise<void>((resolve, reject) => {
			let unsubscribe = (): void => undefined
			const timeout = setTimeout(() => {
				unsubscribe()
				reject(new Error('Timed out waiting for caption polling to recover'))
			}, 1000)
			unsubscribe = session.subscribe(() => {
				const snapshot = session.getSnapshot()
				if (snapshot.cached && snapshot.status?.state === 'completed') {
					clearTimeout(timeout)
					unsubscribe()
					resolve()
				}
			})
		})

		await session.activate(TARGET, true)
		await reachedCompleted

		expect(statusCalls).toBe(3)
		expect(trackCalls).toBe(1)
		expect(session.getSnapshot()).toMatchObject({
			cached: true,
			phase: 'ready',
			status: { state: 'completed' },
		})
		expect(session.textAt(session.seek(0))).toBe('Completed B first')
		session.dispose()
	})

	test('retries the initial status request after a transient activation failure', async () => {
		const cachedBytes = encodeTrack('Cached A')
		const completedBytes = encodeTrack('Recovered B')
		const completed = createCompletedStatus(
			TARGET,
			'"tcap1-recovered-b"',
			completedBytes.byteLength
		)
		const memory = createMemoryRepository({
			artifactUpdatedAt: '2026-09-04T09:59:59.000Z',
			bytes: cachedBytes,
			cueCount: 2,
			durationMilliseconds: 2500,
			etag: '"tcap1-cached-a"',
			fileLength: TARGET.fileLength,
			formatVersion: 1,
			ih: INFO_HASH,
			path: TARGET.path.join('/'),
			updatedAt: 1,
		})
		let statusCalls = 0
		const session = new CaptionSession({
			api: {
				cancel: () => Promise.resolve(),
				getStatus: () => {
					statusCalls += 1
					return statusCalls === 1
						? Promise.reject(new Error('temporary activation failure'))
						: Promise.resolve(completed)
				},
				getTrack: () =>
					Promise.resolve({
						artifactUpdatedAt: ARTIFACT_UPDATED_AT,
						bytes: completedBytes,
						etag: '"tcap1-recovered-b"',
						kind: 'track',
					}),
				start: () => Promise.resolve(createStatus('queued')),
			},
			pollIntervalMs: 50,
			repository: memory.repository,
		})
		const reachedCompleted = new Promise<void>((resolve, reject) => {
			let unsubscribe = (): void => undefined
			const timeout = setTimeout(() => {
				unsubscribe()
				reject(new Error('Timed out waiting for activation retry'))
			}, 1000)
			unsubscribe = session.subscribe(() => {
				const snapshot = session.getSnapshot()
				if (snapshot.cached && snapshot.status?.state === 'completed') {
					clearTimeout(timeout)
					unsubscribe()
					resolve()
				}
			})
		})

		await session.activate(TARGET, true)
		expect(session.getSnapshot()).toMatchObject({
			cached: true,
			message:
				'Saved captions are available. The transcription service could not be reached.',
			phase: 'ready',
		})
		await reachedCompleted

		expect(statusCalls).toBe(2)
		expect(session.getSnapshot()).toMatchObject({
			cached: true,
			phase: 'ready',
			status: { state: 'completed' },
		})
		expect(session.textAt(session.seek(0))).toBe('Recovered B first')
		session.dispose()
	})

	test('keeps the newest server artifact when an older tab download finishes last', async () => {
		const olderBytes = encodeTrack('Older B')
		const newerBytes = encodeTrack('Newer C')
		const olderStatus = createCompletedStatus(
			TARGET,
			'"tcap1-b"',
			olderBytes.byteLength
		)
		const newerStatus = createCompletedStatus(
			TARGET,
			'"tcap1-c"',
			newerBytes.byteLength
		)
		if (!(olderStatus.captions && newerStatus.captions)) {
			throw new Error('Completed fixtures omitted caption metadata')
		}
		olderStatus.captions.updatedAt = '2026-09-04T10:00:01.000Z'
		newerStatus.captions.updatedAt = '2026-09-04T10:00:02.000Z'
		const memory = createMemoryRepository()
		let announceOlderDownload: (() => void) | undefined
		const olderDownloadStarted = new Promise<void>((resolve) => {
			announceOlderDownload = resolve
		})
		let resolveOlderDownload:
			| ((value: {
					artifactUpdatedAt: string
					bytes: ArrayBuffer
					etag: string
					kind: 'track'
			  }) => void)
			| undefined
		const pendingOlderDownload = new Promise<{
			artifactUpdatedAt: string
			bytes: ArrayBuffer
			etag: string
			kind: 'track'
		}>((resolve) => {
			resolveOlderDownload = resolve
		})
		const olderSession = new CaptionSession({
			api: {
				cancel: () => Promise.resolve(),
				getStatus: () => Promise.resolve(olderStatus),
				getTrack: () => {
					announceOlderDownload?.()
					return pendingOlderDownload
				},
				start: () => Promise.resolve(createStatus('queued')),
			},
			repository: memory.repository,
		})
		const newerSession = new CaptionSession({
			api: {
				cancel: () => Promise.resolve(),
				getStatus: () => Promise.resolve(newerStatus),
				getTrack: () =>
					Promise.resolve({
						artifactUpdatedAt: newerStatus.captions?.updatedAt ?? '',
						bytes: newerBytes,
						etag: '"tcap1-c"',
						kind: 'track',
					}),
				start: () => Promise.resolve(createStatus('queued')),
			},
			repository: memory.repository,
		})

		const olderActivation = olderSession.activate(TARGET, true)
		await olderDownloadStarted
		await newerSession.activate(TARGET, true)
		resolveOlderDownload?.({
			artifactUpdatedAt: olderStatus.captions.updatedAt,
			bytes: olderBytes,
			etag: '"tcap1-b"',
			kind: 'track',
		})
		await olderActivation

		expect(memory.getStored(TARGET)?.etag).toBe('"tcap1-c"')
		expect(olderSession.textAt(olderSession.seek(0))).toBe('Newer C first')
		expect(olderSession.getSnapshot().cached).toBe(true)
		olderSession.dispose()
		newerSession.dispose()
	})

	test('promotes a matching cached artifact to the latest server revision', async () => {
		const bytes = encodeTrack('Cached A')
		const previousRevision = '2026-09-04T10:00:01.000Z'
		const currentRevision = '2026-09-04T10:00:03.000Z'
		const etag = '"tcap1-a"'
		const memory = createMemoryRepository({
			artifactUpdatedAt: previousRevision,
			bytes,
			cueCount: 2,
			durationMilliseconds: 2500,
			etag,
			fileLength: TARGET.fileLength,
			formatVersion: 1,
			ih: INFO_HASH,
			path: TARGET.path.join('/'),
			updatedAt: 1,
		})
		const status = createCompletedStatus(TARGET, etag, bytes.byteLength)
		if (!status.captions) {
			throw new Error('Completed fixture omitted caption metadata')
		}
		status.captions.updatedAt = currentRevision
		let trackCalls = 0
		const session = new CaptionSession({
			api: {
				cancel: () => Promise.resolve(),
				getStatus: () => Promise.resolve(status),
				getTrack: () => {
					trackCalls += 1
					return Promise.resolve({ kind: 'missing' })
				},
				start: () => Promise.resolve(createStatus('queued')),
			},
			repository: memory.repository,
		})

		await session.activate(TARGET, true)

		expect(trackCalls).toBe(0)
		expect(memory.getStored(TARGET)?.artifactUpdatedAt).toBe(currentRevision)
		expect(session.textAt(session.seek(0))).toBe('Cached A first')
		session.dispose()
	})

	test('keeps A revision 3 when a delayed B revision 2 write follows A-B-A', async () => {
		const aBytes = encodeTrack('Artifact A')
		const bBytes = encodeTrack('Artifact B')
		const revision1 = '2026-09-04T10:00:01.000Z'
		const revision2 = '2026-09-04T10:00:02.000Z'
		const revision3 = '2026-09-04T10:00:03.000Z'
		const aEtag = '"tcap1-a"'
		const bEtag = '"tcap1-b"'
		const memory = createMemoryRepository({
			artifactUpdatedAt: revision1,
			bytes: aBytes,
			cueCount: 2,
			durationMilliseconds: 2500,
			etag: aEtag,
			fileLength: TARGET.fileLength,
			formatVersion: 1,
			ih: INFO_HASH,
			path: TARGET.path.join('/'),
			updatedAt: 1,
		})
		const staleStatus = createCompletedStatus(TARGET, bEtag, bBytes.byteLength)
		if (!staleStatus.captions) {
			throw new Error('Completed fixture omitted caption metadata')
		}
		staleStatus.captions.updatedAt = revision2
		let conditionalEtag: string | undefined
		const session = new CaptionSession({
			api: {
				cancel: () => Promise.resolve(),
				getStatus: () => Promise.resolve(staleStatus),
				getTrack: (_infoHash, _fileId, requestedEtag) => {
					conditionalEtag = requestedEtag
					return Promise.resolve({
						artifactUpdatedAt: revision3,
						kind: 'not-modified',
					})
				},
				start: () => Promise.resolve(createStatus('queued')),
			},
			repository: memory.repository,
		})

		await session.activate(TARGET, true)
		await memory.repository.putCaptionTrack({
			artifactUpdatedAt: revision2,
			bytes: bBytes,
			cueCount: 2,
			durationMilliseconds: 2500,
			etag: bEtag,
			fileLength: TARGET.fileLength,
			formatVersion: 1,
			ih: INFO_HASH,
			path: TARGET.path.join('/'),
			updatedAt: Number.MAX_SAFE_INTEGER,
		})

		expect(conditionalEtag).toBe(aEtag)
		expect(memory.getStored(TARGET)).toMatchObject({
			artifactUpdatedAt: revision3,
			etag: aEtag,
		})
		expect(session.textAt(session.seek(0))).toBe('Artifact A first')
		session.dispose()
	})

	test('keeps cached captions visible and retryable when a refresh fails', async () => {
		const bytes = encodeTrack('Cached')
		const memory = createMemoryRepository({
			bytes,
			cueCount: 2,
			durationMilliseconds: 2500,
			etag: '"tcap1-cached"',
			fileLength: TARGET.fileLength,
			formatVersion: 1,
			ih: INFO_HASH,
			language: 'en',
			path: TARGET.path.join('/'),
			updatedAt: 1,
		})
		let cancelCalls = 0
		let startCalls = 0
		let serviceStatus = createStatus('failed', TARGET, {
			error: {
				ambiguous: false,
				code: 'provider_unavailable',
				message: 'The refreshed track could not be generated.',
				retryable: true,
			},
		})
		const api: CaptionService = {
			cancel: () => {
				cancelCalls += 1
				serviceStatus = createStatus('cancelled', TARGET, {
					error: {
						ambiguous: false,
						code: 'cancelled',
						message: 'Transcription was cancelled.',
						retryable: true,
					},
				})
				return Promise.resolve()
			},
			getStatus: () => Promise.resolve(serviceStatus),
			getTrack: () => Promise.resolve({ kind: 'missing' }),
			start: () => {
				startCalls += 1
				serviceStatus = createStatus('queued')
				return Promise.resolve(serviceStatus)
			},
		}
		const session = new CaptionSession({ api, repository: memory.repository })

		await session.activate(TARGET, true)

		expect(session.getSnapshot()).toMatchObject({
			cached: true,
			message:
				'Saved captions are shown; refresh failed. The refreshed track could not be generated.',
			phase: 'ready',
			status: { state: 'failed' },
		})
		expect(session.seek(0)).toBe(0)
		expect(session.textAt(0)).toBe('Cached first')

		await session.retry()

		expect(startCalls).toBe(1)
		expect(session.getSnapshot()).toMatchObject({
			cached: true,
			phase: 'ready',
			status: { state: 'queued' },
		})
		expect(session.textAt(session.seek(0))).toBe('Cached first')

		await session.cancel()

		expect(cancelCalls).toBe(1)
		expect(session.getSnapshot()).toMatchObject({
			cached: true,
			message: 'Saved captions are shown; refresh was cancelled.',
			phase: 'ready',
			status: {
				error: { code: 'cancelled', retryable: true },
				state: 'cancelled',
			},
		})
		expect(session.textAt(session.seek(0))).toBe('Cached first')
		session.dispose()
	})

	test('uses the authoritative completed state when cancellation loses a race', async () => {
		const bytes = encodeTrack('Cached')
		const etag = '"tcap1-cancel-race"'
		const memory = createMemoryRepository({
			bytes,
			cueCount: 2,
			durationMilliseconds: 2500,
			etag,
			fileLength: TARGET.fileLength,
			formatVersion: 1,
			ih: INFO_HASH,
			language: 'en',
			path: TARGET.path.join('/'),
			updatedAt: 1,
		})
		let status = createStatus('queued')
		const completed = createCompletedStatus(TARGET, etag, bytes.byteLength)
		const api: CaptionService = {
			cancel: () => {
				status = completed
				return Promise.resolve()
			},
			getStatus: () => Promise.resolve(status),
			getTrack: () => {
				throw new Error(
					'Matching installed captions must not be downloaded again'
				)
			},
			start: () => Promise.resolve(createStatus('queued')),
		}
		const session = new CaptionSession({ api, repository: memory.repository })

		await session.activate(TARGET, true)
		expect(session.getSnapshot()).toMatchObject({
			cached: true,
			phase: 'ready',
			status: { state: 'queued' },
		})

		await session.cancel()

		expect(session.getSnapshot()).toMatchObject({
			cached: true,
			phase: 'ready',
			status: { state: 'completed' },
		})
		expect(session.getSnapshot().message).toBeUndefined()
		expect(session.textAt(session.seek(0))).toBe('Cached first')
		session.dispose()
	})

	test('does not restore a running state when post-cancel verification is offline', async () => {
		const bytes = encodeTrack('Cached')
		const memory = createMemoryRepository({
			artifactUpdatedAt: ARTIFACT_UPDATED_AT,
			bytes,
			cueCount: 2,
			durationMilliseconds: 2500,
			etag: '"tcap1-cached"',
			fileLength: TARGET.fileLength,
			formatVersion: 1,
			ih: INFO_HASH,
			path: TARGET.path.join('/'),
			updatedAt: 1,
		})
		let cancelled = false
		const queued = createStatus('queued')
		const api: CaptionService = {
			cancel: () => {
				cancelled = true
				return Promise.resolve()
			},
			getStatus: () =>
				cancelled
					? Promise.reject(new Error('server is offline'))
					: Promise.resolve(queued),
			getTrack: () => Promise.resolve({ kind: 'missing' }),
			start: () => Promise.resolve(createStatus('queued')),
		}
		const session = new CaptionSession({ api, repository: memory.repository })

		await session.activate(TARGET, true)
		await session.cancel()

		expect(session.getSnapshot()).toMatchObject({
			cached: true,
			message:
				'Saved captions are shown; cancellation was accepted, but its final server status could not be confirmed.',
			phase: 'ready',
			status: { state: 'cancelled' },
		})
		expect(session.textAt(session.seek(0))).toBe('Cached first')
		session.dispose()
	})

	test('keeps an accepted cancellation visible until server cleanup settles', async () => {
		const serverState: { cleanupPending: boolean } = { cleanupPending: true }
		let cancellationCalls = 0
		const cancelledStatus = (): TranscriptionStatus =>
			createStatus('cancelled', TARGET, {
				...(serverState.cleanupPending ? { cleanupPending: true } : {}),
				error: {
					ambiguous: false,
					code: 'cancelled',
					message: 'Transcription was cancelled.',
					retryable: true,
				},
			})
		const session = new CaptionSession({
			api: {
				cancel: () => {
					cancellationCalls += 1
					return Promise.reject(
						new CaptionApiError(
							503,
							'transcription_cleanup_pending',
							'Transcription was cancelled, but cleanup is still in progress.'
						)
					)
				},
				getStatus: () => Promise.resolve(cancelledStatus()),
				getTrack: () => Promise.resolve({ kind: 'missing' }),
				start: () => Promise.resolve(createStatus('queued')),
			},
			pollIntervalMs: 50,
			repository: createMemoryRepository().repository,
		})

		await session.activate(TARGET, true)
		expect(session.getSnapshot()).toMatchObject({
			message: expect.stringContaining(
				'releasing local transcription resources'
			),
			phase: 'cancelling',
			status: { cleanupPending: true, state: 'cancelled' },
		})

		await session.cancel()
		expect(cancellationCalls).toBe(1)
		expect(session.getSnapshot()).toMatchObject({
			phase: 'cancelling',
			status: { cleanupPending: true, state: 'cancelled' },
		})
		expect(session.getSnapshot().connectionIssue).toBeUndefined()

		serverState.cleanupPending = false
		const settled = await waitForSessionSnapshot(
			session,
			(snapshot) => snapshot.phase === 'cancelled'
		)
		expect(settled).toMatchObject({
			message: 'Transcription was cancelled.',
			status: { state: 'cancelled' },
		})
		expect(settled.status).not.toHaveProperty('cleanupPending')
		session.dispose()
	})

	test('keeps a failed attempt non-retryable while local cleanup is owned', async () => {
		const serverState: { cleanupPending: boolean } = { cleanupPending: true }
		const failedStatus = (): TranscriptionStatus =>
			createStatus('failed', TARGET, {
				...(serverState.cleanupPending ? { cleanupPending: true } : {}),
				error: {
					ambiguous: true,
					code: 'timeout',
					message: 'The speech request timed out.',
					retryable: true,
				},
			})
		const session = new CaptionSession({
			api: {
				cancel: () => Promise.resolve(),
				getStatus: () => Promise.resolve(failedStatus()),
				getTrack: () => Promise.resolve({ kind: 'missing' }),
				start: () => Promise.resolve(createStatus('queued')),
			},
			pollIntervalMs: 50,
			repository: createMemoryRepository().repository,
		})

		await session.activate(TARGET, true)
		expect(session.getSnapshot()).toMatchObject({
			message: expect.stringContaining('before this chapter can be retried'),
			phase: 'cleaning',
			status: { cleanupPending: true, state: 'failed' },
		})

		serverState.cleanupPending = false
		const settled = await waitForSessionSnapshot(
			session,
			(snapshot) => snapshot.phase === 'failed'
		)
		expect(settled).toMatchObject({
			message: 'The speech request timed out.',
			status: { state: 'failed' },
		})
		session.dispose()
	})

	test('shows completed captions while their local audio lease is released', async () => {
		const bytes = encodeTrack('Cleanup complete')
		const serverState: { cleanupPending: boolean } = { cleanupPending: true }
		const status = (): TranscriptionStatus => ({
			...createCompletedStatus(TARGET, '"cleanup-complete"', bytes.byteLength),
			...(serverState.cleanupPending ? { cleanupPending: true } : {}),
		})
		const session = new CaptionSession({
			api: {
				cancel: () => Promise.resolve(),
				getStatus: () => Promise.resolve(status()),
				getTrack: () =>
					Promise.resolve({
						artifactUpdatedAt: ARTIFACT_UPDATED_AT,
						bytes,
						etag: '"cleanup-complete"',
						kind: 'track',
					}),
				start: () => Promise.resolve(createStatus('queued')),
			},
			pollIntervalMs: 50,
			repository: createMemoryRepository().repository,
		})

		await session.activate(TARGET, true)
		expect(session.getSnapshot()).toMatchObject({
			message: expect.stringContaining('releasing local audio resources'),
			phase: 'ready',
			status: { cleanupPending: true, state: 'completed' },
		})
		expect(session.textAt(session.seek(0))).toBe('Cleanup complete first')

		serverState.cleanupPending = false
		const settled = await waitForSessionSnapshot(
			session,
			(snapshot) =>
				snapshot.phase === 'ready' &&
				snapshot.status?.state === 'completed' &&
				snapshot.status.cleanupPending !== true &&
				snapshot.message === undefined
		)
		expect(settled.cached).toBe(true)
		expect(session.textAt(session.seek(0))).toBe('Cleanup complete first')
		session.dispose()
	})

	test('keeps polling cleanup when a completed artifact is temporarily missing', async () => {
		const bytes = encodeTrack('Eventually available')
		const serverState: { cleanupPending: boolean; trackAvailable: boolean } = {
			cleanupPending: true,
			trackAvailable: false,
		}
		let statusCalls = 0
		const status = (): TranscriptionStatus => ({
			...createCompletedStatus(TARGET, '"eventual"', bytes.byteLength),
			...(serverState.cleanupPending ? { cleanupPending: true } : {}),
		})
		const session = new CaptionSession({
			api: {
				cancel: () => Promise.resolve(),
				getStatus: () => {
					statusCalls += 1
					return Promise.resolve(status())
				},
				getTrack: () =>
					Promise.resolve(
						serverState.trackAvailable
							? {
									artifactUpdatedAt: ARTIFACT_UPDATED_AT,
									bytes,
									etag: '"eventual"',
									kind: 'track' as const,
								}
							: { kind: 'missing' as const }
					),
				start: () => Promise.resolve(createStatus('queued')),
			},
			pollIntervalMs: 50,
			repository: createMemoryRepository().repository,
		})

		await session.activate(TARGET, true)
		expect(session.getSnapshot()).toMatchObject({
			message: expect.stringContaining('still releasing local audio resources'),
			phase: 'failed',
			status: { cleanupPending: true, state: 'completed' },
		})

		serverState.cleanupPending = false
		serverState.trackAvailable = true
		const ready = await waitForSessionSnapshot(
			session,
			(snapshot) => snapshot.phase === 'ready'
		)
		expect(statusCalls).toBeGreaterThan(1)
		expect(ready.status).not.toHaveProperty('cleanupPending')
		expect(session.textAt(session.seek(0))).toBe('Eventually available first')
		session.dispose()
	})

	test('resumes one requested retry after an overlapping cleanup finishes', async () => {
		const serverState: { cleanupPending: boolean } = { cleanupPending: false }
		let startCalls = 0
		const status = (): TranscriptionStatus =>
			createStatus('failed', TARGET, {
				...(serverState.cleanupPending ? { cleanupPending: true } : {}),
				error: {
					ambiguous: true,
					code: 'timeout',
					message: 'The previous request timed out.',
					retryable: true,
				},
			})
		const session = new CaptionSession({
			api: {
				cancel: () => Promise.resolve(),
				getStatus: () => Promise.resolve(status()),
				getTrack: () => Promise.resolve({ kind: 'missing' }),
				start: () => {
					startCalls += 1
					if (startCalls === 1) {
						serverState.cleanupPending = true
						return Promise.reject(
							new CaptionApiError(
								409,
								'transcription_cleanup_pending',
								'The previous attempt is still releasing resources.'
							)
						)
					}
					return Promise.resolve(createStatus('queued', TARGET, { attempt: 2 }))
				},
			},
			pollIntervalMs: 50,
			repository: createMemoryRepository().repository,
		})

		await session.activate(TARGET, true)
		await session.retry()
		expect(startCalls).toBe(1)
		expect(session.getSnapshot()).toMatchObject({
			phase: 'cleaning',
			status: { cleanupPending: true, state: 'failed' },
		})

		serverState.cleanupPending = false
		const restarted = await waitForSessionSnapshot(
			session,
			(snapshot) => snapshot.status?.state === 'queued'
		)
		expect(startCalls).toBe(2)
		expect(restarted).toMatchObject({
			phase: 'queued',
			status: { attempt: 2, state: 'queued' },
		})
		session.dispose()
	})

	test('finishes a requested restart exactly once after slow cancellation cleanup', async () => {
		const serverState: { cancelled: boolean; cleanupPending: boolean } = {
			cancelled: false,
			cleanupPending: false,
		}
		let cancelCalls = 0
		let startCalls = 0
		const status = (): TranscriptionStatus =>
			createStatus(
				serverState.cancelled ? 'cancelled' : 'transcribing',
				TARGET,
				{
					...(serverState.cleanupPending ? { cleanupPending: true } : {}),
				}
			)
		const session = new CaptionSession({
			api: {
				cancel: () => {
					cancelCalls += 1
					serverState.cancelled = true
					serverState.cleanupPending = true
					return Promise.reject(
						new CaptionApiError(
							503,
							'transcription_cleanup_pending',
							'Cancellation is releasing local resources.'
						)
					)
				},
				getStatus: () => Promise.resolve(status()),
				getTrack: () => Promise.resolve({ kind: 'missing' }),
				start: () => {
					startCalls += 1
					return Promise.resolve(createStatus('queued', TARGET, { attempt: 2 }))
				},
			},
			pollIntervalMs: 50,
			repository: createMemoryRepository().repository,
		})

		await session.activate(TARGET, true)
		await session.restart()
		expect(cancelCalls).toBe(1)
		expect(startCalls).toBe(0)
		expect(session.getSnapshot()).toMatchObject({
			phase: 'cancelling',
			status: { cleanupPending: true, state: 'cancelled' },
		})

		serverState.cleanupPending = false
		const restarted = await waitForSessionSnapshot(
			session,
			(snapshot) => snapshot.status?.state === 'queued'
		)
		expect(cancelCalls).toBe(1)
		expect(startCalls).toBe(1)
		expect(restarted.status).toMatchObject({ attempt: 2, state: 'queued' })
		session.dispose()
	})

	test('requires explicit retry and supports cancellation without an implicit restart', async () => {
		const memory = createMemoryRepository()
		let cancelCalls = 0
		let startCalls = 0
		let serviceStatus = createStatus('failed', TARGET, {
			error: {
				ambiguous: true,
				code: 'provider_timeout',
				message: 'The provider response was ambiguous.',
				retryable: true,
			},
		})
		const api: CaptionService = {
			cancel: () => {
				cancelCalls += 1
				serviceStatus = createStatus('cancelled')
				return Promise.resolve()
			},
			getStatus: () => Promise.resolve(serviceStatus),
			getTrack: () => Promise.resolve({ kind: 'missing' }),
			start: () => {
				startCalls += 1
				serviceStatus = createStatus('queued')
				return Promise.resolve(serviceStatus)
			},
		}
		const session = new CaptionSession({ api, repository: memory.repository })

		await session.activate(TARGET, true)
		expect(session.getSnapshot()).toMatchObject({
			message: 'The provider response was ambiguous.',
			phase: 'failed',
		})
		expect(startCalls).toBe(0)

		await session.retry()
		expect(startCalls).toBe(1)
		expect(session.getSnapshot().phase).toBe('queued')

		await session.cancel()
		expect(cancelCalls).toBe(1)
		expect(session.getSnapshot().phase).toBe('cancelled')
		session.dispose()
	})

	test('preserves a serializable action error and clears it on reconciliation and success', async () => {
		let serviceStatus: TranscriptionStatus | null = null
		const audioNotLocalError = (): CaptionApiError =>
			new CaptionApiError(
				409,
				'audio_not_local',
				'The audiobook must finish downloading before transcription'
			)
		const startErrors: Array<CaptionApiError | null> = [
			audioNotLocalError(),
			audioNotLocalError(),
			null,
		]
		const session = new CaptionSession({
			api: {
				cancel: () => Promise.resolve(),
				getStatus: () => Promise.resolve(serviceStatus),
				getTrack: () => Promise.resolve({ kind: 'missing' }),
				start: () => {
					const error = startErrors.shift()
					if (error) {
						return Promise.reject(error)
					}
					serviceStatus = createStatus('queued')
					return Promise.resolve(serviceStatus)
				},
			},
			repository: createMemoryRepository().repository,
		})

		await session.activate(TARGET, true)
		await session.retry()
		const failed = session.getSnapshot()
		expect(failed).toMatchObject({
			actionError: {
				code: 'audio_not_local',
				message: 'The audiobook must finish downloading before transcription',
				retryable: false,
				status: 409,
			},
			phase: 'failed',
			status: null,
		})
		expect(JSON.parse(JSON.stringify(failed.actionError))).toEqual(
			failed.actionError
		)

		await session.checkStatus()
		expect(session.getSnapshot()).toMatchObject({
			phase: 'unavailable',
			status: null,
		})
		expect(session.getSnapshot().actionError).toBeUndefined()

		await session.retry()
		expect(session.getSnapshot().actionError?.code).toBe('audio_not_local')
		await session.retry()
		expect(session.getSnapshot()).toMatchObject({
			phase: 'queued',
			status: { state: 'queued' },
		})
		expect(session.getSnapshot().actionError).toBeUndefined()
		session.dispose()
	})

	test('reconciles a missing-audio rejection when a server job appears without remounting', async () => {
		let serviceStatus: TranscriptionStatus | null = null
		let startCalls = 0
		const session = new CaptionSession({
			api: {
				cancel: () => Promise.resolve(),
				getStatus: () => Promise.resolve(serviceStatus),
				getTrack: () => Promise.resolve({ kind: 'missing' }),
				start: () => {
					startCalls += 1
					return Promise.reject(
						new CaptionApiError(
							409,
							'audio_not_local',
							'The audiobook must finish downloading before transcription'
						)
					)
				},
			},
			pollIntervalMs: 50,
			repository: createMemoryRepository().repository,
		})

		await session.activate(TARGET, true)
		await session.retry()
		expect(session.getSnapshot()).toMatchObject({
			actionError: { code: 'audio_not_local' },
			phase: 'failed',
		})

		serviceStatus = createStatus('queued')
		const reconciled = await waitForSessionSnapshot(
			session,
			(snapshot) => snapshot.phase === 'queued'
		)
		expect(reconciled).toMatchObject({
			phase: 'queued',
			status: { state: 'queued' },
		})
		expect(reconciled.actionError).toBeUndefined()
		expect(startCalls).toBe(1)
		session.dispose()
	})

	test('distinguishes queued work from an active stalled attempt', async () => {
		const currentTime = Date.parse('2026-09-04T10:30:00.000Z')
		const statuses = [
			createStatus('queued', TARGET, {
				queueBlockedByCleanup: true,
				queuePosition: 33,
				updatedAt: '2026-09-04T08:00:00.000Z',
			}),
			createStatus('transcribing', TARGET, {
				updatedAt: '2026-09-04T08:00:00.000Z',
				watchdogDeadlineAt: '2026-09-04T10:35:00.000Z',
				watchdogRemainingMilliseconds: 300_000,
			}),
			createStatus('transcribing', TARGET, {
				processedMilliseconds: 90_000,
				updatedAt: '2026-09-04T10:00:00.000Z',
				watchdogDeadlineAt: '2026-09-04T10:20:00.000Z',
				watchdogRemainingMilliseconds: 0,
			}),
		]
		let selectedStatus = 0
		const session = new CaptionSession({
			api: {
				cancel: () => Promise.resolve(),
				getStatus: () => Promise.resolve(statuses[selectedStatus] ?? null),
				getTrack: () => Promise.resolve({ kind: 'missing' }),
				start: () => Promise.resolve(createStatus('queued')),
			},
			now: () => currentTime,
			repository: createMemoryRepository().repository,
		})

		await session.activate(TARGET, true)
		expect(session.getSnapshot()).toMatchObject({
			message:
				'Waiting for the previous chapter to release local transcription resources.',
			phase: 'queued',
			status: { queueBlockedByCleanup: true, queuePosition: 33 },
		})
		expect(session.getSnapshot().connectionIssue).toBeUndefined()

		selectedStatus = 1
		await session.checkStatus()
		expect(session.getSnapshot().phase).toBe('transcribing')
		expect(session.getSnapshot().connectionIssue).toBeUndefined()

		selectedStatus = 2
		await session.checkStatus()
		expect(session.getSnapshot()).toMatchObject({
			connectionIssue: {
				consecutiveFailures: 0,
				kind: 'stalled',
			},
			phase: 'transcribing',
			status: { processedMilliseconds: 90_000 },
		})
		session.dispose()
	})

	test('uses server-relative watchdog time despite client clock skew', async () => {
		let remainingMilliseconds = 5000
		const session = new CaptionSession({
			api: {
				cancel: () => Promise.resolve(),
				getStatus: () =>
					Promise.resolve(
						createStatus('transcribing', TARGET, {
							watchdogDeadlineAt: '2001-01-01T00:00:00.000Z',
							watchdogRemainingMilliseconds: remainingMilliseconds,
						})
					),
				getTrack: () => Promise.resolve({ kind: 'missing' }),
				start: () => Promise.resolve(createStatus('queued')),
			},
			now: () => Date.parse('2099-01-01T00:00:00.000Z'),
			repository: createMemoryRepository().repository,
		})

		await session.activate(TARGET, true)
		expect(session.getSnapshot().connectionIssue).toBeUndefined()

		remainingMilliseconds = 0
		await session.checkStatus()
		expect(session.getSnapshot().connectionIssue?.kind).toBe('stalled')
		session.dispose()
	})

	test('requires repeated unchanged observations for legacy stall detection', async () => {
		let elapsedMilliseconds = 0
		const transcribing = createStatus('transcribing')
		const session = new CaptionSession({
			api: {
				cancel: () => Promise.resolve(),
				getStatus: () => Promise.resolve(transcribing),
				getTrack: () => Promise.resolve({ kind: 'missing' }),
				start: () => Promise.resolve(createStatus('queued')),
			},
			elapsedNow: () => elapsedMilliseconds,
			pollIntervalMs: 50,
			repository: createMemoryRepository().repository,
			stallAfterMs: 100,
		})

		await session.activate(TARGET, true)
		elapsedMilliseconds = 101
		await session.checkStatus()
		expect(session.getSnapshot().connectionIssue).toBeUndefined()

		await session.checkStatus()
		expect(session.getSnapshot().connectionIssue?.kind).toBe('stalled')
		session.dispose()
	})

	test('keeps the last running state during polling failure and checks without restarting', async () => {
		let statusCalls = 0
		let startCalls = 0
		let statusReachable = false
		const queued = createStatus('queued', TARGET, { queuePosition: 4 })
		const session = new CaptionSession({
			api: {
				cancel: () => Promise.resolve(),
				getStatus: () => {
					statusCalls += 1
					if (statusCalls === 1 || statusReachable) {
						return Promise.resolve(queued)
					}
					return Promise.reject(new Error('status route offline'))
				},
				getTrack: () => Promise.resolve({ kind: 'missing' }),
				start: () => {
					startCalls += 1
					return Promise.resolve(queued)
				},
			},
			pollIntervalMs: 50,
			repository: createMemoryRepository().repository,
		})

		await session.activate(TARGET, true)
		const unreachable = await waitForSessionSnapshot(
			session,
			(snapshot) => snapshot.connectionIssue?.kind === 'unreachable'
		)
		expect(unreachable).toMatchObject({
			connectionIssue: {
				consecutiveFailures: 1,
				kind: 'unreachable',
			},
			phase: 'queued',
			status: { queuePosition: 4, state: 'queued' },
		})
		expect(startCalls).toBe(0)

		statusReachable = true
		await session.checkStatus()
		expect(session.getSnapshot()).toMatchObject({
			phase: 'queued',
			status: { state: 'queued' },
		})
		expect(session.getSnapshot().connectionIssue).toBeUndefined()
		expect(startCalls).toBe(0)
		session.dispose()
	})

	test('explicitly restarts a stalled attempt by cancelling before starting', async () => {
		const calls: string[] = []
		const stalled = createStatus('transcribing', TARGET, {
			attempt: 4,
			updatedAt: '2026-09-04T10:00:00.000Z',
			watchdogDeadlineAt: '2026-09-04T10:20:00.000Z',
			watchdogRemainingMilliseconds: 0,
		})
		const restarted = createStatus('queued', TARGET, {
			attempt: 5,
			queuePosition: 1,
			updatedAt: '2026-09-04T10:30:00.000Z',
		})
		const session = new CaptionSession({
			api: {
				cancel: () => {
					calls.push('cancel')
					return Promise.resolve()
				},
				getStatus: () => Promise.resolve(stalled),
				getTrack: () => Promise.resolve({ kind: 'missing' }),
				start: () => {
					calls.push('start')
					return Promise.resolve(restarted)
				},
			},
			now: () => Date.parse('2026-09-04T10:30:00.000Z'),
			repository: createMemoryRepository().repository,
		})

		await session.activate(TARGET, true)
		expect(session.getSnapshot().connectionIssue?.kind).toBe('stalled')
		await session.restart()

		expect(calls).toEqual(['cancel', 'start'])
		expect(session.getSnapshot()).toMatchObject({
			phase: 'queued',
			status: { attempt: 5, queuePosition: 1 },
		})
		expect(session.getSnapshot().connectionIssue).toBeUndefined()
		session.dispose()
	})

	test('dispose clears the scheduled poll after a completed status check', async () => {
		let statusCalls = 0
		const session = new CaptionSession({
			api: {
				cancel: () => Promise.resolve(),
				getStatus: () => {
					statusCalls += 1
					return Promise.resolve(createStatus('queued'))
				},
				getTrack: () => Promise.resolve({ kind: 'missing' }),
				start: () => Promise.resolve(createStatus('queued')),
			},
			pollIntervalMs: 50,
			repository: createMemoryRepository().repository,
		})

		await session.activate(TARGET, true)
		session.dispose()
		await new Promise((resolve) => setTimeout(resolve, 80))
		expect(statusCalls).toBe(1)
	})

	test('dispose aborts an in-flight status request', async () => {
		let observedSignal: AbortSignal | undefined
		let announceRequest: (() => void) | undefined
		const requestStarted = new Promise<void>((resolve) => {
			announceRequest = resolve
		})
		const session = new CaptionSession({
			api: {
				cancel: () => Promise.resolve(),
				getStatus: (_infoHash, _fileId, signal) => {
					observedSignal = signal
					announceRequest?.()
					return new Promise<TranscriptionStatus | null>(() => undefined)
				},
				getTrack: () => Promise.resolve({ kind: 'missing' }),
				start: () => Promise.resolve(createStatus('queued')),
			},
			repository: createMemoryRepository().repository,
		})

		const activation = session.activate(TARGET, true)
		await requestStarted
		session.dispose()
		await activation

		expect(observedSignal?.aborted).toBe(true)
		expect(session.getSnapshot().phase).toBe('idle')
	})

	test('turns a hung status request into an unreachable state', async () => {
		let observedSignal: AbortSignal | undefined
		const session = new CaptionSession({
			api: {
				cancel: () => Promise.resolve(),
				getStatus: (_infoHash, _fileId, signal) => {
					observedSignal = signal
					return new Promise<TranscriptionStatus | null>(() => undefined)
				},
				getTrack: () => Promise.resolve({ kind: 'missing' }),
				start: () => Promise.resolve(createStatus('queued')),
			},
			pollIntervalMs: 50,
			repository: createMemoryRepository().repository,
			serviceRequestTimeoutMs: 100,
		})

		await session.activate(TARGET, true)

		expect(observedSignal?.aborted).toBe(true)
		expect(session.getSnapshot()).toMatchObject({
			connectionIssue: {
				consecutiveFailures: 1,
				kind: 'unreachable',
			},
			phase: 'failed',
		})
		session.dispose()
	})

	test('bounds a hung start request and keeps status recovery available', async () => {
		let observedSignal: AbortSignal | undefined
		const session = new CaptionSession({
			api: {
				cancel: () => Promise.resolve(),
				getStatus: () => Promise.resolve(null),
				getTrack: () => Promise.resolve({ kind: 'missing' }),
				start: (_infoHash, _fileId, signal) => {
					observedSignal = signal
					return new Promise<TranscriptionStatus>(() => undefined)
				},
			},
			pollIntervalMs: 50,
			repository: createMemoryRepository().repository,
			serviceRequestTimeoutMs: 100,
		})

		await session.activate(TARGET, true)
		await session.retry()

		expect(observedSignal?.aborted).toBe(true)
		expect(session.getSnapshot()).toMatchObject({
			connectionIssue: {
				consecutiveFailures: 1,
				kind: 'unreachable',
			},
			phase: 'failed',
		})
		session.dispose()
	})

	test('bounds a hung cancellation instead of remaining in cancelling', async () => {
		let observedSignal: AbortSignal | undefined
		const queued = createStatus('queued')
		const session = new CaptionSession({
			api: {
				cancel: (_infoHash, _fileId, signal) => {
					observedSignal = signal
					return new Promise<void>(() => undefined)
				},
				getStatus: () => Promise.resolve(queued),
				getTrack: () => Promise.resolve({ kind: 'missing' }),
				start: () => Promise.resolve(queued),
			},
			pollIntervalMs: 50,
			repository: createMemoryRepository().repository,
			serviceRequestTimeoutMs: 100,
		})

		await session.activate(TARGET, true)
		await session.cancel()

		expect(observedSignal?.aborted).toBe(true)
		expect(session.getSnapshot()).toMatchObject({
			connectionIssue: {
				consecutiveFailures: 1,
				kind: 'unreachable',
			},
			phase: 'queued',
			status: { state: 'queued' },
		})
		session.dispose()
	})

	test('bounds a hung restart request after cancellation', async () => {
		let observedSignal: AbortSignal | undefined
		const transcribing = createStatus('transcribing')
		const session = new CaptionSession({
			api: {
				cancel: () => Promise.resolve(),
				getStatus: () => Promise.resolve(transcribing),
				getTrack: () => Promise.resolve({ kind: 'missing' }),
				start: (_infoHash, _fileId, signal) => {
					observedSignal = signal
					return new Promise<TranscriptionStatus>(() => undefined)
				},
			},
			pollIntervalMs: 50,
			repository: createMemoryRepository().repository,
			serviceRequestTimeoutMs: 100,
		})

		await session.activate(TARGET, true)
		await session.restart()

		expect(observedSignal?.aborted).toBe(true)
		expect(session.getSnapshot()).toMatchObject({
			connectionIssue: {
				consecutiveFailures: 1,
				kind: 'unreachable',
			},
			phase: 'failed',
			status: { state: 'cancelled' },
		})
		session.dispose()
	})

	test('bounds a hung caption track download', async () => {
		let observedSignal: AbortSignal | undefined
		const bytes = encodeTrack('timeout')
		const completed = createCompletedStatus(
			TARGET,
			'"timeout"',
			bytes.byteLength
		)
		const session = new CaptionSession({
			api: {
				cancel: () => Promise.resolve(),
				getStatus: () => Promise.resolve(completed),
				getTrack: (_infoHash, _fileId, _etag, signal) => {
					observedSignal = signal
					return new Promise(() => undefined)
				},
				start: () => Promise.resolve(createStatus('queued')),
			},
			pollIntervalMs: 50,
			repository: createMemoryRepository().repository,
			serviceRequestTimeoutMs: 100,
		})

		await session.activate(TARGET, true)

		expect(observedSignal?.aborted).toBe(true)
		expect(session.getSnapshot()).toMatchObject({
			message: expect.stringContaining('caption file could not be loaded'),
			phase: 'failed',
			status: { state: 'completed' },
		})
		expect(session.getSnapshot().connectionIssue).toBeUndefined()
		session.dispose()
	})

	test('reports an unreadable server artifact without claiming the server is unreachable', async () => {
		const invalidBytes = new Uint8Array([0, 1, 2, 3]).buffer
		const session = new CaptionSession({
			api: {
				cancel: () => Promise.resolve(),
				getStatus: () =>
					Promise.resolve(
						createCompletedStatus(TARGET, '"invalid"', invalidBytes.byteLength)
					),
				getTrack: () =>
					Promise.resolve({
						artifactUpdatedAt: ARTIFACT_UPDATED_AT,
						bytes: invalidBytes,
						etag: '"invalid"',
						kind: 'track',
					}),
				start: () => Promise.resolve(createStatus('queued')),
			},
			repository: createMemoryRepository().repository,
		})

		await session.activate(TARGET, true)

		expect(session.getSnapshot()).toMatchObject({
			message: expect.stringContaining('caption file could not be loaded'),
			phase: 'failed',
			status: { state: 'completed' },
		})
		expect(session.getSnapshot().connectionIssue).toBeUndefined()
		session.dispose()
	})

	test('keeps a running job visible when cancellation is definitively rejected', async () => {
		const queued = createStatus('queued')
		const session = new CaptionSession({
			api: {
				cancel: () =>
					Promise.reject(
						new CaptionApiError(
							409,
							'job_already_finishing',
							'The job is already finishing.'
						)
					),
				getStatus: () => Promise.resolve(queued),
				getTrack: () => Promise.resolve({ kind: 'missing' }),
				start: () => Promise.resolve(queued),
			},
			repository: createMemoryRepository().repository,
		})

		await session.activate(TARGET, true)
		await session.cancel()

		expect(session.getSnapshot()).toMatchObject({
			message:
				'Cancellation was rejected by the server. The job is already finishing.',
			phase: 'queued',
			status: { state: 'queued' },
		})
		expect(session.getSnapshot().connectionIssue).toBeUndefined()
		session.dispose()
	})

	test('reports a definitive restart rejection as a cancelled attempt, not an outage', async () => {
		const transcribing = createStatus('transcribing', TARGET, {
			watchdogRemainingMilliseconds: 0,
		})
		const session = new CaptionSession({
			api: {
				cancel: () => Promise.resolve(),
				getStatus: () => Promise.resolve(transcribing),
				getTrack: () => Promise.resolve({ kind: 'missing' }),
				start: () =>
					Promise.reject(
						new CaptionApiError(
							409,
							'restart_rejected',
							'The previous attempt is still stopping.'
						)
					),
			},
			repository: createMemoryRepository().repository,
		})

		await session.activate(TARGET, true)
		await session.restart()

		expect(session.getSnapshot()).toMatchObject({
			message: expect.stringContaining(
				'Transcription was cancelled, but it could not be restarted.'
			),
			phase: 'failed',
			status: { state: 'cancelled' },
		})
		expect(session.getSnapshot().connectionIssue).toBeUndefined()
		session.dispose()
	})

	test('does not accumulate status requests when an aborted service call never settles', async () => {
		let statusCalls = 0
		const session = new CaptionSession({
			api: {
				cancel: () => Promise.resolve(),
				getStatus: () => {
					statusCalls += 1
					return new Promise<TranscriptionStatus | null>(() => undefined)
				},
				getTrack: () => Promise.resolve({ kind: 'missing' }),
				start: () => Promise.resolve(createStatus('queued')),
			},
			pollIntervalMs: 50,
			repository: createMemoryRepository().repository,
			serviceRequestTimeoutMs: 100,
		})

		await session.activate(TARGET, true)
		await new Promise((resolve) => setTimeout(resolve, 450))

		expect(statusCalls).toBe(1)
		expect(session.getSnapshot()).toMatchObject({
			connectionIssue: { kind: 'unreachable' },
		})
		session.dispose()
	})

	test('globally quarantines an ignored status request across chapter changes', async () => {
		let statusCalls = 0
		const api: CaptionService = {
			cancel: () => Promise.resolve(),
			getStatus: () => {
				statusCalls += 1
				return new Promise<TranscriptionStatus | null>(() => undefined)
			},
			getTrack: () => Promise.resolve({ kind: 'missing' }),
			start: () => Promise.resolve(createStatus('queued')),
		}
		const session = new CaptionSession({
			api,
			pollIntervalMs: 50,
			repository: createMemoryRepository().repository,
			serviceRequestTimeoutMs: 100,
		})
		const targets = [
			TARGET,
			{ ...TARGET, fileId: '8', path: ['Book', '02.mp3'] },
			{ ...TARGET, fileId: '9', path: ['Book', '03.mp3'] },
		]

		for (const target of targets) {
			// biome-ignore lint/performance/noAwaitInLoops: Sequential activation models rapid chapter navigation.
			await session.activate(target, true)
		}
		await new Promise((resolve) => setTimeout(resolve, 250))

		expect(statusCalls).toBe(1)
		expect(session.getSnapshot()).toMatchObject({
			connectionIssue: { kind: 'unreachable' },
		})
		session.dispose()
		expect(statusCalls).toBe(1)

		const replacement = new CaptionSession({
			api,
			pollIntervalMs: 50,
			repository: createMemoryRepository().repository,
			serviceRequestTimeoutMs: 100,
		})
		await replacement.activate(TARGET, true)
		await new Promise((resolve) => setTimeout(resolve, 150))
		expect(statusCalls).toBe(1)
		replacement.dispose()
	})
})

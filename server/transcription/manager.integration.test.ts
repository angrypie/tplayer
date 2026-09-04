import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	CAPTION_FORMAT_VERSION,
	decodeCaptionTrack,
} from '@tplayer/captions/codec'
import { createApp } from '../app'
import type { AppConfig, TranscriptionRuntimeConfig } from '../config'
import { AppDatabase, type TranscriptionJobRecord } from '../database'
import { HttpError } from '../errors'
import type { AppLogger } from '../logger'
import type {
	OpenedTorrentFile,
	TorrentDetails,
	TorrentFileDetails,
	TorrentManager,
} from '../torrent/manager'
import {
	AudioPipelineError,
	type AudioTranscoder,
	type AudioWindow,
} from './audioPipeline'
import { TranscriptionManager } from './manager'
import {
	type SpeechProvider,
	SpeechProviderFailure,
	type SpeechTranscription,
	type SpeechTranscriptionOptions,
} from './provider'

const TEST_TIMEOUT_MS = 10_000
const INFO_HASH = '0123456789abcdef0123456789abcdef01234567'
const SECOND_INFO_HASH = '89abcdef0123456789abcdef0123456789abcdef'
const AUDIO_FILE: TorrentFileDetails = {
	downloaded: 4096,
	id: '0',
	length: 4096,
	mimeType: 'audio/wav',
	name: 'chapter.wav',
	path: ['Book', 'chapter.wav'],
	progress: 1,
}
const SECOND_AUDIO_FILE: TorrentFileDetails = {
	...AUDIO_FILE,
	id: '1',
	name: 'second.wav',
	path: ['Book', 'second.wav'],
}
const THIRD_AUDIO_FILE: TorrentFileDetails = {
	...AUDIO_FILE,
	id: '6',
	name: 'third.wav',
	path: ['Book', 'third.wav'],
}
const COVER_FILE: TorrentFileDetails = {
	downloaded: 67,
	id: '2',
	length: 67,
	mimeType: 'image/png',
	name: 'cover.png',
	path: ['Book', 'cover.png'],
	progress: 1,
}
const MP4_AUDIO_FILE: TorrentFileDetails = {
	...AUDIO_FILE,
	id: '3',
	mimeType: 'video/mp4',
	name: 'chapter.mp4',
	path: ['Book', 'chapter.mp4'],
}
const WEBM_AUDIO_FILE: TorrentFileDetails = {
	...AUDIO_FILE,
	id: '4',
	mimeType: 'video/webm',
	name: 'chapter.webm',
	path: ['Book', 'chapter.webm'],
}
const OTHER_VIDEO_FILE: TorrentFileDetails = {
	...AUDIO_FILE,
	id: '5',
	mimeType: 'video/x-matroska',
	name: 'chapter.mkv',
	path: ['Book', 'chapter.mkv'],
}

type ProviderStep = (
	options: SpeechTranscriptionOptions
) => Promise<SpeechTranscription> | SpeechTranscription

const logger: AppLogger = {
	debug: () => undefined,
	error: () => undefined,
	info: () => undefined,
	warn: () => undefined,
}

const transcriptionConfig: TranscriptionRuntimeConfig = {
	ffmpegPath: 'ffmpeg',
	requestTimeoutMs: 5000,
}

const createConfig = (root: string): AppConfig => ({
	databasePath: join(root, 'history.sqlite'),
	frontendDirectory: root,
	listen: { hostname: '127.0.0.1', port: 0 },
	serveFrontend: false,
	torrent: {
		cacheCapacityBytes: 64 * 1024 * 1024,
		cacheDirectory: join(root, 'cache'),
		dht: false,
		graceMs: 10,
		localServiceDiscovery: false,
		maxConnections: 4,
		metadataTimeoutMs: 1000,
		peerExchange: false,
		torrentPort: 0,
		trackers: false,
		utp: false,
	},
	transcription: transcriptionConfig,
})

const makeLocal = (database: AppDatabase, infoHash = INFO_HASH): void => {
	const magnetUri = `magnet:?xt=urn:btih:${infoHash}`
	database.recordTorrentRegistration(infoHash, 'Book', magnetUri, true)
	database.upsertTorrent(
		infoHash,
		'Book',
		Uint8Array.from([1, 2, 3, 4]),
		magnetUri
	)
	database.saveFileModtimes(infoHash, [Date.now()], true)
	database.recordCache(infoHash, 8192, true)
}

const abortError = (): Error => {
	const error = new Error('cancelled')
	error.name = 'AbortError'
	return error
}

const delay = async (milliseconds: number): Promise<void> => {
	await new Promise<void>((resolve) => {
		setTimeout(resolve, milliseconds)
	})
}

class FakeTorrentService {
	private readonly files: TorrentFileDetails[]
	private listener: ((infoHash: string) => void) | null = null
	openCachedFileCalls = 0

	constructor(files: TorrentFileDetails[] = [AUDIO_FILE, COVER_FILE]) {
		this.files = files
	}

	cachedFile(
		_infoHash: string,
		fileId: string,
		signal?: AbortSignal
	): Promise<TorrentFileDetails> {
		if (signal?.aborted) {
			throw abortError()
		}
		const file = this.files.find((candidate) => candidate.id === fileId)
		if (!file) {
			throw new HttpError(404, 'file_not_found', 'Torrent file was not found')
		}
		return Promise.resolve(file)
	}

	cachedFiles = (): Promise<TorrentFileDetails[]> => Promise.resolve(this.files)

	details = async (infoHash: string): Promise<TorrentDetails> => ({
		downloaded: this.files.reduce((sum, file) => sum + file.length, 0),
		downloadSpeed: 0,
		files: this.files,
		infoHash,
		length: this.files.reduce((sum, file) => sum + file.length, 0),
		magnetUri: `magnet:?xt=urn:btih:${infoHash}`,
		name: 'Book',
		numPeers: 0,
		progress: 1,
		ready: true,
	})

	health = (): {
		activeSessions: number
		destroyed: boolean
		preloadJobs: number
	} => ({ activeSessions: 0, destroyed: false, preloadJobs: 0 })

	isRemoving(_infoHash: string): boolean {
		return false
	}

	onCacheCompleted = (listener: (infoHash: string) => void): (() => void) => {
		this.listener = listener
		return () => {
			if (this.listener === listener) {
				this.listener = null
			}
		}
	}

	openCachedFile(
		_infoHash: string,
		fileId: string,
		signal?: AbortSignal
	): Promise<OpenedTorrentFile> {
		this.openCachedFileCalls += 1
		if (signal?.aborted) {
			throw abortError()
		}
		const file = this.files.find((candidate) => candidate.id === fileId)
		if (!file) {
			throw new Error('Missing fake file')
		}
		return Promise.resolve({
			contentLength: file.length,
			file,
			range: null,
			stream: new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(Uint8Array.from([1, 2, 3, 4]))
					controller.close()
				},
			}),
		})
	}

	emitCacheCompleted(infoHash: string): void {
		this.listener?.(infoHash)
	}
}

interface Deferred<Value> {
	promise: Promise<Value>
	resolve: (value: Value) => void
}

const createDeferred = <Value>(): Deferred<Value> => {
	let resolve = (_value: Value): void => undefined
	const promise = new Promise<Value>((resolvePromise) => {
		resolve = resolvePromise
	})
	return { promise, resolve }
}

class LeaseTrackedTorrentService extends FakeTorrentService {
	private readonly leaseReleased = createDeferred<void>()

	override openCachedFile = (
		_infoHash: string,
		fileId: string,
		signal?: AbortSignal
	): Promise<OpenedTorrentFile> => {
		if (signal?.aborted) {
			throw abortError()
		}
		if (fileId !== AUDIO_FILE.id) {
			throw new Error('Missing lease-tracked file')
		}
		return Promise.resolve({
			contentLength: AUDIO_FILE.length,
			file: AUDIO_FILE,
			range: null,
			stream: new ReadableStream<Uint8Array>({
				cancel: () => {
					this.leaseReleased.resolve()
					throw new Error('Injected stream cancellation failure')
				},
			}),
		})
	}

	waitForLeaseRelease(): Promise<void> {
		return this.leaseReleased.promise
	}
}

class HangingCancelTorrentService extends FakeTorrentService {
	private readonly cancelStarted = createDeferred<void>()
	private readonly releaseCancel = createDeferred<void>()

	override async openCachedFile(
		infoHash: string,
		fileId: string,
		signal?: AbortSignal
	): Promise<OpenedTorrentFile> {
		const opened = await super.openCachedFile(infoHash, fileId, signal)
		if (fileId !== AUDIO_FILE.id) {
			return opened
		}
		return {
			...opened,
			stream: new ReadableStream<Uint8Array>({
				cancel: async () => {
					this.cancelStarted.resolve()
					await this.releaseCancel.promise
				},
			}),
		}
	}

	releaseStreamCancel(): void {
		this.releaseCancel.resolve()
	}

	waitForStreamCancel(): Promise<void> {
		return this.cancelStarted.promise
	}
}

class DeferredCachedFilesTorrentService extends FakeTorrentService {
	private cachedFilesCallCount = 0
	private readonly callWaiters = new Map<number, Deferred<void>>()
	private readonly pendingFiles = createDeferred<TorrentFileDetails[]>()
	private readonly resolvedFiles: TorrentFileDetails[]
	private readonly state: { released: boolean } = { released: false }

	constructor(files: TorrentFileDetails[] = [AUDIO_FILE, COVER_FILE]) {
		super(files)
		this.resolvedFiles = files
	}

	override cachedFiles = (): Promise<TorrentFileDetails[]> => {
		this.cachedFilesCallCount += 1
		for (const [expectedCalls, waiter] of this.callWaiters) {
			if (this.cachedFilesCallCount >= expectedCalls) {
				waiter.resolve()
				this.callWaiters.delete(expectedCalls)
			}
		}
		if (this.state.released) {
			return Promise.resolve(this.resolvedFiles)
		}
		return this.pendingFiles.promise
	}

	override cachedFile = async (
		_infoHash: string,
		fileId: string,
		signal?: AbortSignal
	): Promise<TorrentFileDetails> => {
		const files = await this.cachedFiles()
		if (signal?.aborted) {
			throw abortError()
		}
		const file = files.find((candidate) => candidate.id === fileId)
		if (!file) {
			throw new HttpError(404, 'file_not_found', 'Torrent file was not found')
		}
		return file
	}

	releaseCachedFiles(): void {
		this.state.released = true
		this.pendingFiles.resolve(this.resolvedFiles)
	}

	waitForCachedFiles(): Promise<void> {
		return this.waitForCachedFileCalls(1)
	}

	waitForCachedFileCalls(expectedCalls: number): Promise<void> {
		if (this.cachedFilesCallCount >= expectedCalls) {
			return Promise.resolve()
		}
		const existing = this.callWaiters.get(expectedCalls)
		if (existing) {
			return existing.promise
		}
		const waiter = createDeferred<void>()
		this.callWaiters.set(expectedCalls, waiter)
		return waiter.promise
	}
}

class DeferredRemovalTorrentService extends DeferredCachedFilesTorrentService {
	private readonly continueRemoval = createDeferred<void>()
	private readonly removalEntered = createDeferred<void>()
	private readonly removalFailure = new Error(
		'Injected torrent removal failure'
	)
	private readonly removingHashes = new Set<string>()

	override isRemoving(infoHash: string): boolean {
		return this.removingHashes.has(infoHash)
	}

	async remove(
		infoHash: string,
		beforeRemoval?: () => Promise<void>
	): Promise<boolean> {
		this.removingHashes.add(infoHash)
		try {
			await beforeRemoval?.()
			this.removalEntered.resolve()
			await this.continueRemoval.promise
			throw this.removalFailure
		} finally {
			this.removingHashes.delete(infoHash)
		}
	}

	releaseRemoval(): void {
		this.continueRemoval.resolve()
	}

	waitForRemoval(): Promise<void> {
		return this.removalEntered.promise
	}
}

class RelocalizedTorrentService extends FakeTorrentService {
	private readonly state: { admitted: boolean; local: boolean } = {
		admitted: true,
		local: false,
	}

	markUnavailable(): void {
		this.state.admitted = false
	}

	markRelocalized(): void {
		this.state.admitted = true
		this.state.local = true
	}

	override cachedFile(
		infoHash: string,
		fileId: string,
		signal?: AbortSignal
	): Promise<TorrentFileDetails> {
		if (!this.state.admitted) {
			return Promise.reject(
				new HttpError(
					409,
					'audio_not_local',
					'The selected chapter is not fully available on the server'
				)
			)
		}
		return super.cachedFile(infoHash, fileId, signal)
	}

	override openCachedFile(
		infoHash: string,
		fileId: string,
		signal?: AbortSignal
	): Promise<OpenedTorrentFile> {
		if (!this.state.local) {
			return Promise.reject(
				new HttpError(
					409,
					'audio_not_local',
					'The audiobook was evicted before transcription opened it'
				)
			)
		}
		return super.openCachedFile(infoHash, fileId, signal)
	}
}

class ScriptedTranscoder implements AudioTranscoder {
	private readonly durationMs: number
	private readonly windows: readonly AudioWindow[]

	constructor(
		windows: readonly AudioWindow[] = [
			{
				inputStartMs: 0,
				logicalEndMs: 90_000,
				logicalStartMs: 0,
				wav: Uint8Array.from([1]),
			},
			{
				inputStartMs: 88_000,
				logicalEndMs: 95_000,
				logicalStartMs: 90_000,
				wav: Uint8Array.from([2]),
			},
		],
		durationMs = 95_000
	) {
		this.windows = windows
		this.durationMs = durationMs
	}

	async transcode(
		source: ReadableStream<Uint8Array>,
		signal: AbortSignal,
		onWindow: (window: AudioWindow) => Promise<void>
	): Promise<{ durationMs: number }> {
		await new Response(source).arrayBuffer()
		for (const window of this.windows) {
			if (signal.aborted) {
				throw abortError()
			}
			// biome-ignore lint/performance/noAwaitInLoops: The fake preserves the production pipeline's sequential contract.
			await onWindow(window)
		}
		return { durationMs: this.durationMs }
	}
}

class CountingTranscoder implements AudioTranscoder {
	calls = 0
	private readonly delegate: AudioTranscoder

	constructor(delegate: AudioTranscoder) {
		this.delegate = delegate
	}

	async transcode(
		source: ReadableStream<Uint8Array>,
		signal: AbortSignal,
		onWindow: (window: AudioWindow) => Promise<void>
	): Promise<{ durationMs: number }> {
		this.calls += 1
		return await this.delegate.transcode(source, signal, onWindow)
	}
}

class ScriptedProvider implements SpeechProvider {
	readonly id = 'fake-speech'
	activeCalls = 0
	calls = 0
	maxActiveCalls = 0
	readonly model: string
	readonly options: SpeechTranscriptionOptions[] = []
	resetCalls = 0
	private readonly steps: ProviderStep[]

	constructor(steps: ProviderStep[], model = 'fake-model-v1') {
		this.steps = steps
		this.model = model
	}

	reset(): void {
		this.resetCalls += 1
	}

	async transcribe(
		_wav: Uint8Array,
		options: SpeechTranscriptionOptions
	): Promise<SpeechTranscription> {
		const step = this.steps[this.calls]
		if (!step) {
			throw new Error('Unexpected provider call')
		}
		this.calls += 1
		this.activeCalls += 1
		this.maxActiveCalls = Math.max(this.maxActiveCalls, this.activeCalls)
		this.options.push(options)
		try {
			return await step(options)
		} finally {
			this.activeCalls -= 1
		}
	}
}

const waitForState = async (
	manager: TranscriptionManager,
	state: TranscriptionJobRecord['state'],
	fileId = AUDIO_FILE.id,
	startedAt = performance.now()
): Promise<void> => {
	if (manager.get(INFO_HASH, fileId)?.state === state) {
		return
	}
	if (performance.now() - startedAt > TEST_TIMEOUT_MS) {
		throw new Error(`Timed out waiting for transcription state ${state}`)
	}
	await delay(5)
	await waitForState(manager, state, fileId, startedAt)
}

const waitForManagerIdle = async (
	manager: TranscriptionManager,
	startedAt = performance.now()
): Promise<void> => {
	if (manager.health().activeJobs === 0) {
		return
	}
	if (performance.now() - startedAt > TEST_TIMEOUT_MS) {
		throw new Error('Timed out waiting for transcription manager cleanup')
	}
	await delay(5)
	await waitForManagerIdle(manager, startedAt)
}

const createManager = (
	database: AppDatabase,
	torrentService: FakeTorrentService,
	provider: SpeechProvider,
	transcoder: AudioTranscoder = new ScriptedTranscoder(),
	config: TranscriptionRuntimeConfig = transcriptionConfig
): TranscriptionManager =>
	new TranscriptionManager({
		config,
		database,
		logger,
		provider,
		torrentManager: torrentService as unknown as TorrentManager,
		transcoder,
	})

describe('server transcription integration', () => {
	test(
		'automatic local transcription persists compact captions and serves ETag-aware routes',
		async () => {
			const root = await mkdtemp(join(tmpdir(), 'tplayer-transcription-'))
			const database = new AppDatabase(join(root, 'history.sqlite'))
			const torrentService = new FakeTorrentService()
			const provider = new ScriptedProvider([
				() => ({
					language: 'en',
					words: [
						{ endMs: 1500, startMs: 1000, text: 'Hello' },
						{ endMs: 89_100, startMs: 88_800, text: 'Foo' },
						{ endMs: 89_500, startMs: 89_200, text: 'Bar' },
						{ endMs: 89_750, startMs: 89_550, text: 'Echo' },
						{ endMs: 90_300, startMs: 89_700, text: 'Exact' },
						{ endMs: 90_300, startMs: 89_950, text: 'Crossed' },
					],
				}),
				(options) => {
					expect(options.language).toBeUndefined()
					return {
						language: 'en',
						words: [
							{ endMs: 1100, startMs: 900, text: 'Foo' },
							{ endMs: 1450, startMs: 1250, text: 'Bar,' },
							{ endMs: 1700, startMs: 1600, text: 'continues' },
							{ endMs: 1900, startMs: 1800, text: 'Echo' },
							{ endMs: 2150, startMs: 1850, text: 'Exact' },
							{ endMs: 2000, startMs: 1900, text: 'Crossed' },
							{ endMs: 2900, startMs: 2500, text: 'world.' },
						],
					}
				},
			])
			const manager = createManager(database, torrentService, provider)
			try {
				makeLocal(database)
				await manager.start()
				const app = createApp({
					config: createConfig(root),
					database,
					logger,
					manager: torrentService as unknown as TorrentManager,
					serveFrontend: false,
					transcriptions: manager,
				})

				const initialSetting = await app.request('/api/settings/transcription')
				expect(await initialSetting.json()).toEqual({
					automaticTranscription: false,
					cleanupPending: false,
				})
				const settingResponse = await app.request(
					'/api/settings/transcription',
					{
						body: JSON.stringify({ automaticTranscription: true }),
						headers: { 'Content-Type': 'application/json' },
						method: 'PUT',
					}
				)
				expect(settingResponse.status).toBe(200)
				await waitForState(manager, 'completed')

				const listResponse = await app.request(
					`/api/torrents/${INFO_HASH}/transcriptions`
				)
				const statuses = (await listResponse.json()) as Array<{
					captions?: {
						byteLength: number
						etag: string
						updatedAt: string
						url: string
					}
					state: string
				}>
				expect(statuses).toHaveLength(1)
				expect(statuses[0]?.state).toBe('completed')
				expect(statuses[0]?.captions?.byteLength).toBeGreaterThan(40)
				expect(provider.calls).toBe(2)
				expect(provider.maxActiveCalls).toBe(1)

				const captionsUrl = statuses[0]?.captions?.url
				if (!captionsUrl) {
					throw new Error('Completed status omitted captions URL')
				}
				const captionResponse = await app.request(captionsUrl)
				expect(captionResponse.status).toBe(200)
				expect(captionResponse.headers.get('Content-Type')).toBe(
					'application/vnd.tplayer.captions; version=1'
				)
				expect(captionResponse.headers.get('Cache-Control')).toBe(
					'private, max-age=0, must-revalidate'
				)
				const etag = captionResponse.headers.get('ETag')
				const expectedEtag = statuses[0]?.captions?.etag
				const expectedUpdatedAt = statuses[0]?.captions?.updatedAt
				if (!expectedEtag) {
					throw new Error('Completed status omitted captions ETag')
				}
				if (!expectedUpdatedAt) {
					throw new Error('Completed status omitted captions updatedAt')
				}
				expect(new Date(expectedUpdatedAt).toISOString()).toBe(
					expectedUpdatedAt
				)
				expect(etag).toBe(expectedEtag)
				expect(
					captionResponse.headers.get('X-TPlayer-Caption-Updated-At')
				).toBe(expectedUpdatedAt)
				const bytes = new Uint8Array(await captionResponse.arrayBuffer())
				const track = decodeCaptionTrack(bytes)
				expect(track.durationMs).toBe(95_000)
				expect(track.segmentCount).toBe(2)
				expect(track.textAt(0)).toBe('Hello')
				expect(track.textAt(1)).toBe(
					'Foo Bar, continues Echo Exact Crossed world.'
				)
				expect(track.startMsAt(1)).toBe(88_900)

				const notModified = await app.request(captionsUrl, {
					headers: { 'If-None-Match': etag ?? '' },
				})
				expect(notModified.status).toBe(304)
				expect(notModified.headers.get('X-TPlayer-Caption-Updated-At')).toBe(
					expectedUpdatedAt
				)
				expect((await notModified.arrayBuffer()).byteLength).toBe(0)
				const conditionalResponses = await Promise.all(
					[`W/${etag}`, `"unrelated", W/${etag}`, '*'].map((ifNoneMatch) =>
						app.request(captionsUrl, {
							headers: { 'If-None-Match': ifNoneMatch },
						})
					)
				)
				for (const conditional of conditionalResponses) {
					expect(conditional.status).toBe(304)
				}
				const noncurrentFormatVersion = CAPTION_FORMAT_VERSION + 1
				database.connection
					.query(
						`UPDATE caption_artifacts
						 SET format_version = ?
						 WHERE info_hash = ? AND file_path = ?`
					)
					.run(noncurrentFormatVersion, INFO_HASH, AUDIO_FILE.path.join('/'))
				const noncurrentFormat = await app.request(captionsUrl)
				expect(noncurrentFormat.status).toBe(200)
				expect(noncurrentFormat.headers.get('Content-Type')).toBe(
					`application/vnd.tplayer.captions; version=${noncurrentFormatVersion}`
				)
				expect(noncurrentFormat.headers.get('X-TPlayer-Caption-Version')).toBe(
					String(noncurrentFormatVersion)
				)
				expect(noncurrentFormat.headers.get('ETag')).toBe(
					expectedEtag.replace(
						`tcap${CAPTION_FORMAT_VERSION}-`,
						`tcap${noncurrentFormatVersion}-`
					)
				)

				const healthResponse = await app.request('/api/health')
				const health = (await healthResponse.json()) as {
					transcription: { automaticTranscription: boolean }
				}
				expect(health.transcription.automaticTranscription).toBe(true)

				const removeResponse = await app.request(
					`/api/torrents/${INFO_HASH}/files/${AUDIO_FILE.id}/transcription`,
					{ method: 'DELETE' }
				)
				expect(removeResponse.status).toBe(204)
				expect((await app.request(captionsUrl)).status).toBe(200)
				expect(manager.get(INFO_HASH, AUDIO_FILE.id)?.state).toBe('completed')
			} finally {
				await manager.close()
				database.close()
				await rm(root, { force: true, recursive: true })
			}
		},
		TEST_TIMEOUT_MS
	)

	test(
		'does not reuse a detected language as a hint and records the majority result',
		async () => {
			const root = await mkdtemp(join(tmpdir(), 'tplayer-transcription-'))
			const database = new AppDatabase(join(root, 'history.sqlite'))
			const torrentService = new FakeTorrentService()
			const provider = new ScriptedProvider(
				['kk', 'ru', 'ru'].map((language, index) => (options) => {
					expect(options.language).toBeUndefined()
					return {
						language,
						words: [
							{
								endMs: 800,
								startMs: 200,
								text: `Window ${index + 1}.`,
							},
						],
					}
				})
			)
			const transcoder = new ScriptedTranscoder(
				[
					{
						inputStartMs: 0,
						logicalEndMs: 90_000,
						logicalStartMs: 0,
						wav: Uint8Array.from([1]),
					},
					{
						inputStartMs: 88_000,
						logicalEndMs: 180_000,
						logicalStartMs: 90_000,
						wav: Uint8Array.from([2]),
					},
					{
						inputStartMs: 178_000,
						logicalEndMs: 185_000,
						logicalStartMs: 180_000,
						wav: Uint8Array.from([3]),
					},
				],
				185_000
			)
			const manager = createManager(
				database,
				torrentService,
				provider,
				transcoder
			)
			try {
				makeLocal(database)
				await manager.start()
				await manager.queueFile(INFO_HASH, AUDIO_FILE.id, 'manual')
				await waitForState(manager, 'completed')

				expect(provider.calls).toBe(3)
				expect(manager.getArtifact(INFO_HASH, AUDIO_FILE.id)?.language).toBe(
					'ru'
				)
			} finally {
				await manager.close()
				database.close()
				await rm(root, { force: true, recursive: true })
			}
		},
		TEST_TIMEOUT_MS
	)

	test(
		'manually transcribes a complete selected chapter before the whole torrent is cached',
		async () => {
			const root = await mkdtemp(join(tmpdir(), 'tplayer-transcription-'))
			const database = new AppDatabase(join(root, 'history.sqlite'))
			const torrentService = new FakeTorrentService()
			const provider = new ScriptedProvider([
				() => ({
					language: 'en',
					words: [{ endMs: 800, startMs: 200, text: 'Local chapter.' }],
				}),
			])
			const manager = createManager(
				database,
				torrentService,
				provider,
				new ScriptedTranscoder(
					[
						{
							inputStartMs: 0,
							logicalEndMs: 1000,
							logicalStartMs: 0,
							wav: Uint8Array.from([1]),
						},
					],
					1000
				)
			)
			try {
				makeLocal(database)
				database.recordCache(INFO_HASH, AUDIO_FILE.length, false)
				await manager.start()

				await expect(
					manager.queueFile(INFO_HASH, AUDIO_FILE.id, 'automatic')
				).rejects.toMatchObject({ code: 'audio_not_local', status: 409 })
				await manager.queueFile(INFO_HASH, AUDIO_FILE.id, 'manual')
				await waitForState(manager, 'completed')

				expect(provider.calls).toBe(1)
				expect(manager.get(INFO_HASH, AUDIO_FILE.id)).toMatchObject({
					state: 'completed',
					trigger: 'manual',
				})
			} finally {
				await manager.close()
				database.close()
				await rm(root, { force: true, recursive: true })
			}
		},
		TEST_TIMEOUT_MS
	)

	test(
		'transcribes MP4 automatically and WebM manually without accepting arbitrary video containers',
		async () => {
			const root = await mkdtemp(join(tmpdir(), 'tplayer-transcription-'))
			const database = new AppDatabase(join(root, 'history.sqlite'))
			const torrentService = new FakeTorrentService([
				MP4_AUDIO_FILE,
				WEBM_AUDIO_FILE,
				OTHER_VIDEO_FILE,
			])
			const provider = new ScriptedProvider([
				() => ({
					words: [{ endMs: 500, startMs: 200, text: 'WebM.' }],
				}),
				() => ({
					words: [{ endMs: 500, startMs: 200, text: 'MP4.' }],
				}),
			])
			const manager = createManager(
				database,
				torrentService,
				provider,
				new ScriptedTranscoder(
					[
						{
							inputStartMs: 0,
							logicalEndMs: 1000,
							logicalStartMs: 0,
							wav: Uint8Array.from([1]),
						},
					],
					1000
				)
			)
			try {
				makeLocal(database)
				await manager.start()

				await manager.queueFile(INFO_HASH, WEBM_AUDIO_FILE.id, 'manual')
				await waitForState(manager, 'completed', WEBM_AUDIO_FILE.id)
				expect(manager.get(INFO_HASH, WEBM_AUDIO_FILE.id)).toMatchObject({
					state: 'completed',
					trigger: 'manual',
				})

				await manager.setAutomaticTranscriptionEnabled(true)
				await waitForState(manager, 'completed', MP4_AUDIO_FILE.id)
				expect(manager.get(INFO_HASH, MP4_AUDIO_FILE.id)).toMatchObject({
					state: 'completed',
					trigger: 'automatic',
				})
				expect(manager.get(INFO_HASH, OTHER_VIDEO_FILE.id)).toBeNull()
				await expect(
					manager.queueFile(INFO_HASH, OTHER_VIDEO_FILE.id, 'manual')
				).rejects.toMatchObject({ code: 'file_not_audio', status: 422 })
				expect(provider.calls).toBe(2)
			} finally {
				await manager.close()
				database.close()
				await rm(root, { force: true, recursive: true })
			}
		},
		TEST_TIMEOUT_MS
	)

	test(
		'retries an audio_not_local race only after the audiobook is local again',
		async () => {
			const root = await mkdtemp(join(tmpdir(), 'tplayer-transcription-'))
			const database = new AppDatabase(join(root, 'history.sqlite'))
			const torrentService = new RelocalizedTorrentService()
			const provider = new ScriptedProvider([
				() => ({
					words: [{ endMs: 500, startMs: 200, text: 'Restored.' }],
				}),
			])
			const manager = createManager(
				database,
				torrentService,
				provider,
				new ScriptedTranscoder(
					[
						{
							inputStartMs: 0,
							logicalEndMs: 1000,
							logicalStartMs: 0,
							wav: Uint8Array.from([1]),
						},
					],
					1000
				)
			)
			try {
				makeLocal(database)
				await manager.start()
				await manager.queueFile(INFO_HASH, AUDIO_FILE.id, 'manual')
				await waitForState(manager, 'failed')
				expect(manager.get(INFO_HASH, AUDIO_FILE.id)).toMatchObject({
					attempt: 1,
					error: {
						ambiguous: false,
						code: 'audio_not_local',
						retryable: true,
					},
				})
				expect(provider.calls).toBe(0)

				database.removeCacheEntry(INFO_HASH)
				torrentService.markUnavailable()
				await expect(
					manager.queueFile(INFO_HASH, AUDIO_FILE.id, 'manual')
				).rejects.toMatchObject({ code: 'audio_not_local', status: 409 })
				expect(manager.get(INFO_HASH, AUDIO_FILE.id)?.attempt).toBe(1)

				database.recordCache(INFO_HASH, 8192, true)
				torrentService.markRelocalized()
				const retry = await manager.queueFile(
					INFO_HASH,
					AUDIO_FILE.id,
					'manual'
				)
				expect(retry.attempt).toBe(2)
				await waitForState(manager, 'completed')
				expect(provider.calls).toBe(1)
				expect(manager.get(INFO_HASH, AUDIO_FILE.id)?.state).toBe('completed')
			} finally {
				await manager.close()
				database.close()
				await rm(root, { force: true, recursive: true })
			}
		},
		TEST_TIMEOUT_MS
	)

	test(
		'preserves completed captions through retry cancellation and server refresh',
		async () => {
			const root = await mkdtemp(join(tmpdir(), 'tplayer-transcription-'))
			const database = new AppDatabase(join(root, 'history.sqlite'))
			const torrentService = new FakeTorrentService()
			const transcoder = new ScriptedTranscoder(
				[
					{
						inputStartMs: 0,
						logicalEndMs: 2000,
						logicalStartMs: 0,
						wav: Uint8Array.from([1]),
					},
				],
				2000
			)
			let manager = createManager(
				database,
				torrentService,
				new ScriptedProvider([
					() => ({
						words: [{ endMs: 800, startMs: 300, text: 'Previous.' }],
					}),
				]),
				transcoder
			)
			try {
				makeLocal(database)
				await manager.start()
				await manager.queueFile(INFO_HASH, AUDIO_FILE.id, 'manual')
				await waitForState(manager, 'completed')
				const completed = manager.get(INFO_HASH, AUDIO_FILE.id)
				const completedEtag = completed?.captions?.etag
				if (!completedEtag) {
					throw new Error('Completed job omitted its captions')
				}
				await manager.close()

				const retryProvider = new ScriptedProvider(
					[
						(options) =>
							new Promise<SpeechTranscription>((_resolve, reject) => {
								if (options.signal.aborted) {
									reject(abortError())
									return
								}
								options.signal.addEventListener(
									'abort',
									() => {
										reject(abortError())
									},
									{ once: true }
								)
							}),
					],
					'fake-model-v2'
				)
				manager = createManager(
					database,
					torrentService,
					retryProvider,
					transcoder
				)
				await manager.start()
				const retry = await manager.queueFile(
					INFO_HASH,
					AUDIO_FILE.id,
					'manual'
				)
				expect(retry.captions?.etag).toBe(completedEtag)
				await waitForState(manager, 'transcribing')
				expect(await manager.cancelFile(INFO_HASH, AUDIO_FILE.id)).toBe(true)
				const cancelled = manager.get(INFO_HASH, AUDIO_FILE.id)
				expect(cancelled).toMatchObject({
					captions: { etag: completedEtag },
					error: { code: 'cancelled' },
					state: 'cancelled',
				})
				await manager.close()

				manager = createManager(
					database,
					torrentService,
					new ScriptedProvider([], 'fake-model-v2'),
					transcoder
				)
				await manager.start()
				const refreshed = manager.get(INFO_HASH, AUDIO_FILE.id)
				expect(refreshed).toMatchObject({
					captions: { etag: completedEtag },
					state: 'cancelled',
				})
				const captionsUrl = refreshed?.captions?.url
				if (!captionsUrl) {
					throw new Error('Refreshed cancelled job omitted prior captions')
				}
				const app = createApp({
					config: createConfig(root),
					database,
					logger,
					manager: torrentService as unknown as TorrentManager,
					serveFrontend: false,
					transcriptions: manager,
				})
				expect((await app.request(captionsUrl)).status).toBe(200)
				const durableJob = database.getTranscriptionJob(
					INFO_HASH,
					AUDIO_FILE.path.join('/')
				)
				if (!durableJob) {
					throw new Error('Cancelled job was not persisted')
				}
				database.putTranscriptionJob({
					...durableJob,
					fileLength: durableJob.fileLength + 1,
					updatedAt: new Date().toISOString(),
				})
				expect(manager.get(INFO_HASH, AUDIO_FILE.id)?.captions).toBeUndefined()
				expect(manager.getArtifact(INFO_HASH, AUDIO_FILE.id)).toBeNull()
				expect((await app.request(captionsUrl)).status).toBe(404)
			} finally {
				await manager.close()
				database.close()
				await rm(root, { force: true, recursive: true })
			}
		},
		TEST_TIMEOUT_MS
	)

	test(
		'releases an unread direct-cache stream when transcoder setup fails',
		async () => {
			const root = await mkdtemp(join(tmpdir(), 'tplayer-transcription-'))
			const database = new AppDatabase(join(root, 'history.sqlite'))
			const torrentService = new LeaseTrackedTorrentService()
			const provider = new ScriptedProvider([])
			const manager = createManager(database, torrentService, provider, {
				transcode: () => {
					throw new AudioPipelineError(
						'transcoder_setup_failed',
						'Transcoder failed before reading the source stream.'
					)
				},
			})
			try {
				makeLocal(database)
				await manager.start()
				await manager.queueFile(INFO_HASH, AUDIO_FILE.id, 'manual')
				await waitForState(manager, 'failed')
				await torrentService.waitForLeaseRelease()

				expect(manager.get(INFO_HASH, AUDIO_FILE.id)).toMatchObject({
					error: {
						code: 'transcoder_setup_failed',
						message: 'Transcoder failed before reading the source stream.',
					},
					state: 'failed',
				})
				expect(provider.calls).toBe(0)
			} finally {
				await manager.close()
				database.close()
				await rm(root, { force: true, recursive: true })
			}
		},
		TEST_TIMEOUT_MS
	)

	test(
		'never automatically retries ambiguous failures and retries only on an explicit request',
		async () => {
			const root = await mkdtemp(join(tmpdir(), 'tplayer-transcription-'))
			const database = new AppDatabase(join(root, 'history.sqlite'))
			const torrentService = new FakeTorrentService()
			const provider = new ScriptedProvider([
				() => {
					throw new SpeechProviderFailure(
						'timeout',
						'The local speech request may have completed.',
						{ ambiguous: true, retryable: true }
					)
				},
				() => ({
					words: [{ endMs: 2000, startMs: 1950, text: 'Recovered.' }],
				}),
				() => ({ words: [] }),
			])
			const manager = createManager(
				database,
				torrentService,
				provider,
				new ScriptedTranscoder(
					[
						{
							inputStartMs: 0,
							logicalEndMs: 2000,
							logicalStartMs: 0,
							wav: Uint8Array.from([1]),
						},
					],
					2000
				)
			)
			try {
				makeLocal(database)
				await manager.start()
				await manager.queueFile(INFO_HASH, AUDIO_FILE.id, 'manual')
				await waitForState(manager, 'failed')
				expect(manager.get(INFO_HASH, AUDIO_FILE.id)).toMatchObject({
					attempt: 1,
					error: { ambiguous: true, code: 'timeout', retryable: true },
				})
				await delay(30)
				expect(provider.calls).toBe(1)

				const retry = await manager.queueFile(
					INFO_HASH,
					AUDIO_FILE.id,
					'manual'
				)
				expect(retry.attempt).toBe(2)
				await waitForState(manager, 'completed')
				expect(provider.calls).toBe(2)
				expect(manager.get(INFO_HASH, AUDIO_FILE.id)?.attempt).toBe(2)
				const artifact = manager.getArtifact(INFO_HASH, AUDIO_FILE.id)
				if (!artifact) {
					throw new Error('Completed retry omitted its caption artifact')
				}
				const track = decodeCaptionTrack(artifact.bytes)
				expect(track.endMsAt(0)).toBe(2000)

				await manager.queueFile(INFO_HASH, AUDIO_FILE.id, 'manual')
				await delay(30)
				expect(provider.calls).toBe(2)
			} finally {
				await manager.close()
				database.close()
				await rm(root, { force: true, recursive: true })
			}
		},
		TEST_TIMEOUT_MS
	)

	test(
		'cancels an in-flight provider request and persists its cancelled state',
		async () => {
			const root = await mkdtemp(join(tmpdir(), 'tplayer-transcription-'))
			const database = new AppDatabase(join(root, 'history.sqlite'))
			const torrentService = new FakeTorrentService()
			const provider = new ScriptedProvider([
				(options) =>
					new Promise<SpeechTranscription>((_resolve, reject) => {
						if (options.signal.aborted) {
							reject(
								new SpeechProviderFailure(
									'cancelled',
									'Provider request was cancelled.'
								)
							)
							return
						}
						options.signal.addEventListener(
							'abort',
							() => {
								reject(
									new SpeechProviderFailure(
										'cancelled',
										'Provider request was cancelled.'
									)
								)
							},
							{ once: true }
						)
					}),
			])
			const manager = createManager(
				database,
				torrentService,
				provider,
				new ScriptedTranscoder(
					[
						{
							inputStartMs: 0,
							logicalEndMs: 2000,
							logicalStartMs: 0,
							wav: Uint8Array.from([1]),
						},
					],
					2000
				)
			)
			try {
				makeLocal(database)
				await manager.start()
				await manager.queueFile(INFO_HASH, AUDIO_FILE.id, 'manual')
				await waitForState(manager, 'transcribing')
				await manager.cancelTorrent(INFO_HASH, false)
				expect(provider.activeCalls).toBe(0)
				expect(manager.get(INFO_HASH, AUDIO_FILE.id)).toMatchObject({
					error: { code: 'cancelled', retryable: true },
					state: 'cancelled',
				})
				await manager.cancelFile(INFO_HASH, AUDIO_FILE.id)
				expect(manager.get(INFO_HASH, AUDIO_FILE.id)?.state).toBe('cancelled')
				expect(database.listTranscriptionJobs(INFO_HASH)).toHaveLength(1)
				await manager.cancelTorrent(INFO_HASH, true)
				expect(manager.get(INFO_HASH, AUDIO_FILE.id)).toBeNull()
				expect(database.listTranscriptionJobs(INFO_HASH)).toEqual([])
			} finally {
				await manager.close()
				database.close()
				await rm(root, { force: true, recursive: true })
			}
		},
		TEST_TIMEOUT_MS
	)

	test(
		'bulk cancellation tombstones every pending chapter before active cleanup can repump',
		async () => {
			const root = await mkdtemp(join(tmpdir(), 'tplayer-transcription-'))
			const database = new AppDatabase(join(root, 'history.sqlite'))
			const files = Array.from({ length: 33 }, (_unused, index) => ({
				...AUDIO_FILE,
				id: String(index),
				name: `${String(index + 1).padStart(3, '0')}.wav`,
				path: ['Book', `${String(index + 1).padStart(3, '0')}.wav`],
			}))
			const torrentService = new FakeTorrentService(files)
			const providerStarted = createDeferred<void>()
			const provider = new ScriptedProvider([
				(options) =>
					new Promise<SpeechTranscription>((_resolve, reject) => {
						providerStarted.resolve()
						const cancel = (): void => {
							reject(
								new SpeechProviderFailure(
									'cancelled',
									'Provider request was cancelled.'
								)
							)
						}
						if (options.signal.aborted) {
							cancel()
							return
						}
						options.signal.addEventListener('abort', cancel, { once: true })
					}),
			])
			const transcoder = new CountingTranscoder(
				new ScriptedTranscoder(
					[
						{
							inputStartMs: 0,
							logicalEndMs: 1000,
							logicalStartMs: 0,
							wav: Uint8Array.from([1]),
						},
					],
					1000
				)
			)
			const manager = createManager(
				database,
				torrentService,
				provider,
				transcoder
			)
			try {
				makeLocal(database)
				await manager.start()
				await expect(
					manager.queueTorrent(INFO_HASH, 'manual')
				).resolves.toHaveLength(33)
				await providerStarted.promise

				await manager.cancelTorrent(INFO_HASH, true)

				expect(transcoder.calls).toBe(1)
				expect(torrentService.openCachedFileCalls).toBe(1)
				expect(database.listTranscriptionJobs(INFO_HASH)).toEqual([])
				expect(manager.health()).toMatchObject({
					activeJobs: 0,
					healthy: true,
					queuedJobs: 0,
				})
			} finally {
				await manager.close()
				database.close()
				await rm(root, { force: true, recursive: true })
			}
		},
		TEST_TIMEOUT_MS
	)

	test(
		'purge keeps a cleanup tombstone while an ignored provider call remains owned',
		async () => {
			const root = await mkdtemp(join(tmpdir(), 'tplayer-transcription-'))
			const database = new AppDatabase(join(root, 'history.sqlite'))
			const torrentService = new FakeTorrentService()
			const providerStarted = createDeferred<void>()
			const releaseProvider = createDeferred<void>()
			const provider = new ScriptedProvider([
				async () => {
					providerStarted.resolve()
					await releaseProvider.promise
					return { words: [] }
				},
			])
			const manager = createManager(
				database,
				torrentService,
				provider,
				new ScriptedTranscoder(
					[
						{
							inputStartMs: 0,
							logicalEndMs: 1000,
							logicalStartMs: 0,
							wav: Uint8Array.from([1]),
						},
					],
					1000
				),
				{ ...transcriptionConfig, requestTimeoutMs: 100 }
			)
			try {
				makeLocal(database)
				await manager.start()
				await manager.queueFile(INFO_HASH, AUDIO_FILE.id, 'manual')
				await providerStarted.promise
				await expect(
					manager.cancelTorrent(INFO_HASH, true)
				).rejects.toMatchObject({ code: 'transcription_cleanup_pending' })
				expect(manager.get(INFO_HASH, AUDIO_FILE.id)).toMatchObject({
					cleanupPending: true,
					error: { code: 'cancelled' },
					state: 'cancelled',
				})
				expect(manager.health()).toMatchObject({
					activeJobs: 1,
					healthy: false,
					stalledJobs: 1,
				})
				expect(provider.resetCalls).toBe(1)
				expect(provider.activeCalls).toBe(1)
				releaseProvider.resolve()
				await waitForManagerIdle(manager)
				expect(provider.activeCalls).toBe(0)
				expect(manager.get(INFO_HASH, AUDIO_FILE.id)).toBeNull()
				expect(database.listTranscriptionJobs(INFO_HASH)).toEqual([])
				expect(manager.health()).toMatchObject({
					activeJobs: 0,
					healthy: true,
					stalledJobs: 0,
				})
			} finally {
				releaseProvider.resolve()
				await manager.close()
				database.close()
				await rm(root, { force: true, recursive: true })
			}
		},
		TEST_TIMEOUT_MS
	)

	test(
		'provider watchdog quarantines an unresponsive client until its owned call settles',
		async () => {
			const root = await mkdtemp(join(tmpdir(), 'tplayer-transcription-'))
			const database = new AppDatabase(join(root, 'history.sqlite'))
			const torrentService = new FakeTorrentService([
				AUDIO_FILE,
				SECOND_AUDIO_FILE,
			])
			const providerStarted = createDeferred<void>()
			const releaseProvider = createDeferred<void>()
			const provider = new ScriptedProvider([
				async () => {
					providerStarted.resolve()
					await releaseProvider.promise
					return { words: [] }
				},
				() => ({
					words: [{ endMs: 600, startMs: 200, text: 'Recovered.' }],
				}),
			])
			const window: AudioWindow = {
				inputStartMs: 0,
				logicalEndMs: 1000,
				logicalStartMs: 0,
				wav: Uint8Array.from([1]),
			}
			const transcoder = new CountingTranscoder(
				new ScriptedTranscoder([window], 1000)
			)
			const manager = createManager(
				database,
				torrentService,
				provider,
				transcoder,
				{ ...transcriptionConfig, requestTimeoutMs: 100 }
			)
			try {
				makeLocal(database)
				await manager.start()
				await manager.queueFile(INFO_HASH, AUDIO_FILE.id, 'manual')
				await providerStarted.promise
				await manager.queueFile(INFO_HASH, SECOND_AUDIO_FILE.id, 'manual')

				const active = manager.get(INFO_HASH, AUDIO_FILE.id)
				expect(active).toMatchObject({
					queuedAhead: 0,
					queuePosition: 1,
					state: 'transcribing',
				})
				expect(Date.parse(active?.watchdogDeadlineAt ?? '')).toBeNumber()
				expect(active?.watchdogRemainingMilliseconds).toBeGreaterThanOrEqual(0)
				expect(active?.watchdogRemainingMilliseconds).toBeLessThanOrEqual(100)
				expect(manager.get(INFO_HASH, SECOND_AUDIO_FILE.id)).toMatchObject({
					queuedAhead: 1,
					queuePosition: 2,
					state: 'queued',
				})

				await waitForState(manager, 'failed')
				expect(manager.get(INFO_HASH, AUDIO_FILE.id)).toMatchObject({
					cleanupPending: true,
					error: { ambiguous: true, code: 'timeout', retryable: true },
					state: 'failed',
				})
				expect(manager.get(INFO_HASH, SECOND_AUDIO_FILE.id)).toMatchObject({
					queueBlockedByCleanup: true,
					state: 'queued',
				})
				expect(transcoder.calls).toBe(1)
				expect(manager.health()).toMatchObject({
					activeJobs: 1,
					healthy: false,
					queuedJobs: 1,
					stalledJobs: 1,
				})

				releaseProvider.resolve()
				await waitForState(manager, 'completed', SECOND_AUDIO_FILE.id)
				expect(transcoder.calls).toBe(2)
				expect(provider.calls).toBe(2)
				expect(provider.resetCalls).toBe(1)
				expect(manager.health()).toEqual({
					activeJobs: 0,
					automaticTranscription: false,
					healthy: true,
					queuedJobs: 0,
					stalledJobs: 0,
				})
			} finally {
				releaseProvider.resolve()
				await manager.close()
				database.close()
				await rm(root, { force: true, recursive: true })
			}
		},
		TEST_TIMEOUT_MS
	)

	test(
		'automatic scans skip a manually cancelled cleanup owner without replaying it',
		async () => {
			const root = await mkdtemp(join(tmpdir(), 'tplayer-transcription-'))
			const database = new AppDatabase(join(root, 'history.sqlite'))
			const torrentService = new FakeTorrentService([
				AUDIO_FILE,
				SECOND_AUDIO_FILE,
			])
			const providerStarted = createDeferred<void>()
			const releaseProvider = createDeferred<void>()
			const provider = new ScriptedProvider([
				async () => {
					providerStarted.resolve()
					await releaseProvider.promise
					return { words: [] }
				},
				() => ({
					words: [{ endMs: 600, startMs: 200, text: 'Later chapter.' }],
				}),
			])
			const manager = createManager(
				database,
				torrentService,
				provider,
				new ScriptedTranscoder(
					[
						{
							inputStartMs: 0,
							logicalEndMs: 1000,
							logicalStartMs: 0,
							wav: Uint8Array.from([1]),
						},
					],
					1000
				),
				{ ...transcriptionConfig, requestTimeoutMs: 100 }
			)
			try {
				makeLocal(database)
				await manager.start()
				await manager.queueFile(INFO_HASH, AUDIO_FILE.id, 'manual')
				await providerStarted.promise

				await expect(
					manager.cancelFile(INFO_HASH, AUDIO_FILE.id)
				).rejects.toMatchObject({ code: 'transcription_cleanup_pending' })
				await expect(
					manager.queueTorrent(INFO_HASH, 'manual')
				).rejects.toMatchObject({ code: 'transcription_cleanup_pending' })
				expect(manager.get(INFO_HASH, SECOND_AUDIO_FILE.id)).toBeNull()

				await manager.setAutomaticTranscriptionEnabled(true)
				expect(manager.get(INFO_HASH, AUDIO_FILE.id)).toMatchObject({
					attempt: 1,
					cleanupPending: true,
					state: 'cancelled',
					trigger: 'manual',
				})
				expect(manager.get(INFO_HASH, SECOND_AUDIO_FILE.id)).toMatchObject({
					attempt: 1,
					queueBlockedByCleanup: true,
					state: 'queued',
					trigger: 'automatic',
				})
				expect(provider.calls).toBe(1)

				releaseProvider.resolve()
				await waitForState(manager, 'completed', SECOND_AUDIO_FILE.id)
				expect(provider.calls).toBe(2)
				expect(manager.get(INFO_HASH, AUDIO_FILE.id)).toMatchObject({
					attempt: 1,
					state: 'cancelled',
					trigger: 'manual',
				})
			} finally {
				releaseProvider.resolve()
				await manager.close()
				database.close()
				await rm(root, { force: true, recursive: true })
			}
		},
		TEST_TIMEOUT_MS
	)

	test(
		'stalled transcode and stream lease cleanup both settle before the queue advances',
		async () => {
			const root = await mkdtemp(join(tmpdir(), 'tplayer-transcription-'))
			const database = new AppDatabase(join(root, 'history.sqlite'))
			const torrentService = new HangingCancelTorrentService([
				AUDIO_FILE,
				SECOND_AUDIO_FILE,
			])
			const provider = new ScriptedProvider([
				() => ({
					words: [{ endMs: 600, startMs: 200, text: 'Continued.' }],
				}),
			])
			const completingTranscoder = new ScriptedTranscoder(
				[
					{
						inputStartMs: 0,
						logicalEndMs: 1000,
						logicalStartMs: 0,
						wav: Uint8Array.from([1]),
					},
				],
				1000
			)
			const releaseTranscoder = createDeferred<void>()
			const transcoderState = { calls: 0 }
			const transcoder: AudioTranscoder = {
				transcode: async (source, signal, onWindow) => {
					transcoderState.calls += 1
					if (transcoderState.calls === 1) {
						await releaseTranscoder.promise
						if (signal.aborted) {
							throw abortError()
						}
						return { durationMs: 1000 }
					}
					return await completingTranscoder.transcode(source, signal, onWindow)
				},
			}
			const manager = createManager(
				database,
				torrentService,
				provider,
				transcoder,
				{ ...transcriptionConfig, requestTimeoutMs: 100 }
			)
			try {
				makeLocal(database)
				await manager.start()
				await manager.queueFile(INFO_HASH, AUDIO_FILE.id, 'manual')
				await waitForState(manager, 'transcribing')
				await manager.queueFile(INFO_HASH, SECOND_AUDIO_FILE.id, 'manual')

				await waitForState(manager, 'failed')
				expect(manager.health()).toMatchObject({
					activeJobs: 1,
					healthy: false,
					queuedJobs: 1,
					stalledJobs: 1,
				})
				expect(manager.get(INFO_HASH, AUDIO_FILE.id)).toMatchObject({
					cleanupPending: true,
					error: { code: 'transcription_stalled', retryable: true },
					state: 'failed',
				})
				expect(manager.get(INFO_HASH, SECOND_AUDIO_FILE.id)).toMatchObject({
					queueBlockedByCleanup: true,
					state: 'queued',
				})
				expect(transcoderState.calls).toBe(1)

				releaseTranscoder.resolve()
				await torrentService.waitForStreamCancel()
				expect(transcoderState.calls).toBe(1)
				expect(manager.get(INFO_HASH, SECOND_AUDIO_FILE.id)).toMatchObject({
					queueBlockedByCleanup: true,
					state: 'queued',
				})
				torrentService.releaseStreamCancel()
				await waitForState(manager, 'completed', SECOND_AUDIO_FILE.id)
				expect(transcoderState.calls).toBe(2)
				expect(manager.health()).toMatchObject({
					activeJobs: 0,
					healthy: true,
					queuedJobs: 0,
					stalledJobs: 0,
				})
			} finally {
				releaseTranscoder.resolve()
				torrentService.releaseStreamCancel()
				await manager.close()
				database.close()
				await rm(root, { force: true, recursive: true })
			}
		},
		TEST_TIMEOUT_MS
	)

	test(
		'cancelled queued attempts cannot jump ahead when the same chapter is retried',
		async () => {
			const root = await mkdtemp(join(tmpdir(), 'tplayer-transcription-'))
			const database = new AppDatabase(join(root, 'history.sqlite'))
			const torrentService = new FakeTorrentService([
				AUDIO_FILE,
				SECOND_AUDIO_FILE,
				THIRD_AUDIO_FILE,
			])
			const firstProviderStarted = createDeferred<void>()
			const releaseFirstProvider = createDeferred<void>()
			const nextProviderStarted = createDeferred<void>()
			const releaseNextProvider = createDeferred<void>()
			const provider = new ScriptedProvider([
				async () => {
					firstProviderStarted.resolve()
					await releaseFirstProvider.promise
					return { words: [] }
				},
				async () => {
					nextProviderStarted.resolve()
					await releaseNextProvider.promise
					return { words: [] }
				},
				() => ({ words: [] }),
			])
			const manager = createManager(
				database,
				torrentService,
				provider,
				new ScriptedTranscoder(
					[
						{
							inputStartMs: 0,
							logicalEndMs: 1000,
							logicalStartMs: 0,
							wav: Uint8Array.from([1]),
						},
					],
					1000
				)
			)
			try {
				makeLocal(database)
				await manager.start()
				await manager.queueFile(INFO_HASH, AUDIO_FILE.id, 'manual')
				await firstProviderStarted.promise
				await manager.queueFile(INFO_HASH, SECOND_AUDIO_FILE.id, 'manual')
				await manager.queueFile(INFO_HASH, THIRD_AUDIO_FILE.id, 'manual')
				expect(manager.get(INFO_HASH, THIRD_AUDIO_FILE.id)).toMatchObject({
					queuedAhead: 2,
					queuePosition: 3,
				})

				await manager.cancelFile(INFO_HASH, SECOND_AUDIO_FILE.id)
				await manager.queueFile(INFO_HASH, SECOND_AUDIO_FILE.id, 'manual')
				expect(manager.get(INFO_HASH, THIRD_AUDIO_FILE.id)).toMatchObject({
					queuedAhead: 1,
					queuePosition: 2,
				})
				expect(manager.get(INFO_HASH, SECOND_AUDIO_FILE.id)).toMatchObject({
					attempt: 2,
					queuedAhead: 2,
					queuePosition: 3,
				})

				releaseFirstProvider.resolve()
				await nextProviderStarted.promise
				await waitForState(manager, 'transcribing', THIRD_AUDIO_FILE.id)
				expect(manager.get(INFO_HASH, SECOND_AUDIO_FILE.id)).toMatchObject({
					queuedAhead: 1,
					queuePosition: 2,
					state: 'queued',
				})

				releaseNextProvider.resolve()
				await waitForState(manager, 'completed', THIRD_AUDIO_FILE.id)
				await waitForState(manager, 'completed', SECOND_AUDIO_FILE.id)
				expect(provider.calls).toBe(3)
			} finally {
				releaseFirstProvider.resolve()
				releaseNextProvider.resolve()
				await manager.close()
				database.close()
				await rm(root, { force: true, recursive: true })
			}
		},
		TEST_TIMEOUT_MS
	)

	test(
		'resumes only setting-cancelled automatic work when automatic transcription is re-enabled',
		async () => {
			const root = await mkdtemp(join(tmpdir(), 'tplayer-transcription-'))
			const database = new AppDatabase(join(root, 'history.sqlite'))
			const torrentService = new FakeTorrentService()
			const provider = new ScriptedProvider([
				(options) =>
					new Promise<SpeechTranscription>((_resolve, reject) => {
						options.signal.addEventListener(
							'abort',
							() => {
								reject(
									new SpeechProviderFailure(
										'cancelled',
										'Provider request was cancelled.'
									)
								)
							},
							{ once: true }
						)
					}),
				() => ({
					words: [{ endMs: 500, startMs: 200, text: 'Resumed.' }],
				}),
			])
			const manager = createManager(
				database,
				torrentService,
				provider,
				new ScriptedTranscoder(
					[
						{
							inputStartMs: 0,
							logicalEndMs: 1000,
							logicalStartMs: 0,
							wav: Uint8Array.from([1]),
						},
					],
					1000
				)
			)
			try {
				makeLocal(database)
				await manager.start()
				await manager.setAutomaticTranscriptionEnabled(true)
				await waitForState(manager, 'transcribing')
				await manager.setAutomaticTranscriptionEnabled(false)
				expect(manager.get(INFO_HASH, AUDIO_FILE.id)).toMatchObject({
					error: { code: 'automatic_disabled' },
					state: 'cancelled',
				})

				await manager.setAutomaticTranscriptionEnabled(true)
				await waitForState(manager, 'completed')
				expect(provider.calls).toBe(2)
				expect(manager.get(INFO_HASH, AUDIO_FILE.id)).toMatchObject({
					attempt: 2,
					state: 'completed',
				})
			} finally {
				await manager.close()
				database.close()
				await rm(root, { force: true, recursive: true })
			}
		},
		TEST_TIMEOUT_MS
	)

	test(
		'accepts automatic disable while physical cleanup remains pending',
		async () => {
			const root = await mkdtemp(join(tmpdir(), 'tplayer-transcription-'))
			const database = new AppDatabase(join(root, 'history.sqlite'))
			const torrentService = new FakeTorrentService()
			const providerStarted = createDeferred<void>()
			const releaseProvider = createDeferred<void>()
			const provider = new ScriptedProvider([
				async () => {
					providerStarted.resolve()
					await releaseProvider.promise
					return { words: [] }
				},
			])
			const manager = createManager(
				database,
				torrentService,
				provider,
				new ScriptedTranscoder(
					[
						{
							inputStartMs: 0,
							logicalEndMs: 1000,
							logicalStartMs: 0,
							wav: Uint8Array.from([1]),
						},
					],
					1000
				),
				{ ...transcriptionConfig, requestTimeoutMs: 100 }
			)
			try {
				makeLocal(database)
				await manager.start()
				const app = createApp({
					config: createConfig(root),
					database,
					logger,
					manager: torrentService as unknown as TorrentManager,
					serveFrontend: false,
					transcriptions: manager,
				})
				const enabled = await app.request('/api/settings/transcription', {
					body: JSON.stringify({ automaticTranscription: true }),
					headers: { 'Content-Type': 'application/json' },
					method: 'PUT',
				})
				expect(enabled.status).toBe(200)
				await providerStarted.promise

				const disabled = await app.request('/api/settings/transcription', {
					body: JSON.stringify({ automaticTranscription: false }),
					headers: { 'Content-Type': 'application/json' },
					method: 'PUT',
				})

				expect(disabled.status).toBe(202)
				expect(await disabled.json()).toEqual({
					automaticTranscription: false,
					cleanupPending: true,
				})
				expect(
					await (await app.request('/api/settings/transcription')).json()
				).toEqual({
					automaticTranscription: false,
					cleanupPending: true,
				})
				expect(manager.get(INFO_HASH, AUDIO_FILE.id)).toMatchObject({
					cleanupPending: true,
					error: { code: 'automatic_disabled' },
					state: 'cancelled',
				})

				releaseProvider.resolve()
				await waitForManagerIdle(manager)
				expect(manager.getAutomaticTranscriptionSetting()).toEqual({
					automaticTranscription: false,
					cleanupPending: false,
				})
			} finally {
				releaseProvider.resolve()
				await manager.close()
				database.close()
				await rm(root, { force: true, recursive: true })
			}
		},
		TEST_TIMEOUT_MS
	)

	test(
		'requeues automatic-disabled work once when re-enabled before old cleanup settles',
		async () => {
			const root = await mkdtemp(join(tmpdir(), 'tplayer-transcription-'))
			const database = new AppDatabase(join(root, 'history.sqlite'))
			const torrentService = new FakeTorrentService()
			const providerStarted = createDeferred<void>()
			const releaseProvider = createDeferred<void>()
			const provider = new ScriptedProvider([
				async () => {
					providerStarted.resolve()
					await releaseProvider.promise
					return { words: [] }
				},
				() => ({
					words: [{ endMs: 500, startMs: 200, text: 'Deferred resume.' }],
				}),
			])
			const manager = createManager(
				database,
				torrentService,
				provider,
				new ScriptedTranscoder(
					[
						{
							inputStartMs: 0,
							logicalEndMs: 1000,
							logicalStartMs: 0,
							wav: Uint8Array.from([1]),
						},
					],
					1000
				),
				{ ...transcriptionConfig, requestTimeoutMs: 100 }
			)
			try {
				makeLocal(database)
				await manager.start()
				expect(await manager.setAutomaticTranscriptionEnabled(true)).toEqual({
					automaticTranscription: true,
					cleanupPending: false,
				})
				await providerStarted.promise

				expect(await manager.setAutomaticTranscriptionEnabled(false)).toEqual({
					automaticTranscription: false,
					cleanupPending: true,
				})
				expect(await manager.setAutomaticTranscriptionEnabled(true)).toEqual({
					automaticTranscription: true,
					cleanupPending: true,
				})
				expect(provider.calls).toBe(1)
				expect(manager.get(INFO_HASH, AUDIO_FILE.id)).toMatchObject({
					attempt: 1,
					cleanupPending: true,
					error: { code: 'automatic_disabled' },
					state: 'cancelled',
				})

				releaseProvider.resolve()
				await waitForState(manager, 'completed')
				await delay(20)
				expect(provider.calls).toBe(2)
				expect(manager.get(INFO_HASH, AUDIO_FILE.id)).toMatchObject({
					attempt: 2,
					state: 'completed',
					trigger: 'automatic',
				})
				expect(manager.getAutomaticTranscriptionSetting()).toEqual({
					automaticTranscription: true,
					cleanupPending: false,
				})
			} finally {
				releaseProvider.resolve()
				await manager.close()
				database.close()
				await rm(root, { force: true, recursive: true })
			}
		},
		TEST_TIMEOUT_MS
	)

	test(
		'serializes overlapping disable and enable transitions before requeuing automatic work',
		async () => {
			const root = await mkdtemp(join(tmpdir(), 'tplayer-transcription-'))
			const database = new AppDatabase(join(root, 'history.sqlite'))
			const torrentService = new FakeTorrentService()
			const cancellationObserved = createDeferred<void>()
			const finishCancellation = createDeferred<void>()
			const provider = new ScriptedProvider([
				async (options) => {
					await new Promise<void>((resolve) => {
						if (options.signal.aborted) {
							resolve()
							return
						}
						options.signal.addEventListener('abort', () => resolve(), {
							once: true,
						})
					})
					cancellationObserved.resolve()
					await finishCancellation.promise
					throw new SpeechProviderFailure(
						'cancelled',
						'Provider request was cancelled.'
					)
				},
				() => ({
					words: [{ endMs: 500, startMs: 200, text: 'Latest wins.' }],
				}),
			])
			const manager = createManager(
				database,
				torrentService,
				provider,
				new ScriptedTranscoder(
					[
						{
							inputStartMs: 0,
							logicalEndMs: 1000,
							logicalStartMs: 0,
							wav: Uint8Array.from([1]),
						},
					],
					1000
				)
			)
			try {
				makeLocal(database)
				await manager.start()
				await manager.setAutomaticTranscriptionEnabled(true)
				await waitForState(manager, 'transcribing')

				const disabling = manager.setAutomaticTranscriptionEnabled(false)
				await cancellationObserved.promise
				const enabling = manager.setAutomaticTranscriptionEnabled(true)
				await delay(0)
				expect(manager.getAutomaticTranscriptionEnabled()).toBe(true)

				finishCancellation.resolve()
				await disabling
				await enabling
				await waitForState(manager, 'completed')
				expect(manager.getAutomaticTranscriptionEnabled()).toBe(true)
				expect(provider.calls).toBe(2)
				expect(manager.get(INFO_HASH, AUDIO_FILE.id)).toMatchObject({
					attempt: 2,
					state: 'completed',
					trigger: 'automatic',
				})
			} finally {
				finishCancellation.resolve()
				await manager.close()
				database.close()
				await rm(root, { force: true, recursive: true })
			}
		},
		TEST_TIMEOUT_MS
	)

	test(
		'drops cache-complete automatic work that resolves after disabling',
		async () => {
			const root = await mkdtemp(join(tmpdir(), 'tplayer-transcription-'))
			const database = new AppDatabase(join(root, 'history.sqlite'))
			const torrentService = new DeferredCachedFilesTorrentService()
			const provider = new ScriptedProvider([
				() => ({
					words: [{ endMs: 500, startMs: 200, text: 'Manual.' }],
				}),
			])
			const manager = createManager(
				database,
				torrentService,
				provider,
				new ScriptedTranscoder(
					[
						{
							inputStartMs: 0,
							logicalEndMs: 1000,
							logicalStartMs: 0,
							wav: Uint8Array.from([1]),
						},
					],
					1000
				)
			)
			try {
				makeLocal(database)
				await manager.start()
				database.setAutomaticTranscriptionEnabled(true)
				torrentService.emitCacheCompleted(INFO_HASH)
				await torrentService.waitForCachedFiles()
				await manager.setAutomaticTranscriptionEnabled(false)
				torrentService.releaseCachedFiles()
				await delay(0)

				expect(database.listTranscriptionJobs(INFO_HASH)).toEqual([])
				expect(provider.calls).toBe(0)
				await manager.queueFile(INFO_HASH, AUDIO_FILE.id, 'manual')
				await waitForState(manager, 'completed')
				expect(manager.get(INFO_HASH, AUDIO_FILE.id)?.trigger).toBe('manual')
				expect(provider.calls).toBe(1)
			} finally {
				await manager.close()
				database.close()
				await rm(root, { force: true, recursive: true })
			}
		},
		TEST_TIMEOUT_MS
	)

	test(
		'drops enable-scan automatic work that resolves after disabling',
		async () => {
			const root = await mkdtemp(join(tmpdir(), 'tplayer-transcription-'))
			const database = new AppDatabase(join(root, 'history.sqlite'))
			const torrentService = new DeferredCachedFilesTorrentService()
			const provider = new ScriptedProvider([
				() => ({
					words: [{ endMs: 500, startMs: 200, text: 'Too late.' }],
				}),
			])
			const manager = createManager(database, torrentService, provider)
			try {
				makeLocal(database)
				await manager.start()
				const enabling = manager.setAutomaticTranscriptionEnabled(true)
				await torrentService.waitForCachedFiles()
				const disabling = manager.setAutomaticTranscriptionEnabled(false)
				expect(manager.getAutomaticTranscriptionEnabled()).toBe(false)
				torrentService.releaseCachedFiles()
				await enabling
				await disabling
				await delay(0)

				expect(manager.getAutomaticTranscriptionEnabled()).toBe(false)
				expect(database.listTranscriptionJobs(INFO_HASH)).toEqual([])
				expect(provider.calls).toBe(0)
			} finally {
				await manager.close()
				database.close()
				await rm(root, { force: true, recursive: true })
			}
		},
		TEST_TIMEOUT_MS
	)

	test(
		'rejects deferred automatic and manual queues after deletion is reserved and restores admission when removal fails',
		async () => {
			const root = await mkdtemp(join(tmpdir(), 'tplayer-transcription-'))
			const database = new AppDatabase(join(root, 'history.sqlite'))
			const torrentService = new DeferredRemovalTorrentService()
			const provider = new ScriptedProvider([
				() => ({
					words: [{ endMs: 500, startMs: 200, text: 'Retried.' }],
				}),
			])
			const manager = createManager(
				database,
				torrentService,
				provider,
				new ScriptedTranscoder(
					[
						{
							inputStartMs: 0,
							logicalEndMs: 1000,
							logicalStartMs: 0,
							wav: Uint8Array.from([1]),
						},
					],
					1000
				)
			)
			try {
				makeLocal(database)
				await manager.start()
				database.setAutomaticTranscriptionEnabled(true)
				torrentService.emitCacheCompleted(INFO_HASH)
				await torrentService.waitForCachedFileCalls(1)

				const manualQueue = manager.queueFile(
					INFO_HASH,
					AUDIO_FILE.id,
					'manual'
				)
				await torrentService.waitForCachedFileCalls(2)
				const app = createApp({
					config: createConfig(root),
					database,
					logger,
					manager: torrentService as unknown as TorrentManager,
					serveFrontend: false,
					transcriptions: manager,
				})
				const deletion = app.request(`/api/torrents/${INFO_HASH}`, {
					method: 'DELETE',
				})
				await torrentService.waitForRemoval()
				expect(torrentService.isRemoving(INFO_HASH)).toBe(true)

				torrentService.releaseCachedFiles()
				await expect(manualQueue).rejects.toMatchObject({
					code: 'torrent_removing',
					status: 409,
				})
				await delay(0)
				expect(database.listTranscriptionJobs(INFO_HASH)).toEqual([])
				expect(provider.calls).toBe(0)
				expect(torrentService.openCachedFileCalls).toBe(0)

				torrentService.releaseRemoval()
				expect((await deletion).status).toBe(500)
				expect(torrentService.isRemoving(INFO_HASH)).toBe(false)

				await manager.queueFile(INFO_HASH, AUDIO_FILE.id, 'manual')
				await waitForState(manager, 'completed')
				expect(provider.calls).toBe(1)
				expect(manager.get(INFO_HASH, AUDIO_FILE.id)).toMatchObject({
					state: 'completed',
					trigger: 'manual',
				})
			} finally {
				await manager.close()
				database.close()
				await rm(root, { force: true, recursive: true })
			}
		},
		TEST_TIMEOUT_MS
	)

	test(
		'does not recover persisted automatic queue entries while the setting is disabled',
		async () => {
			const root = await mkdtemp(join(tmpdir(), 'tplayer-transcription-'))
			const database = new AppDatabase(join(root, 'history.sqlite'))
			const torrentService = new FakeTorrentService([
				AUDIO_FILE,
				SECOND_AUDIO_FILE,
			])
			const provider = new ScriptedProvider([
				() => ({
					words: [{ endMs: 500, startMs: 200, text: 'Manual.' }],
				}),
			])
			const manager = createManager(
				database,
				torrentService,
				provider,
				new ScriptedTranscoder(
					[
						{
							inputStartMs: 0,
							logicalEndMs: 1000,
							logicalStartMs: 0,
							wav: Uint8Array.from([1]),
						},
					],
					1000
				)
			)
			try {
				makeLocal(database)
				const timestamp = new Date().toISOString()
				const baseJob = {
					attempt: 1,
					createdAt: timestamp,
					errorAmbiguous: false,
					errorCode: null,
					errorMessage: null,
					errorRetryable: false,
					fileLength: AUDIO_FILE.length,
					finishedAt: null,
					infoHash: INFO_HASH,
					model: provider.model,
					processedMilliseconds: 0,
					provider: provider.id,
					startedAt: null,
					state: 'queued',
					totalMilliseconds: null,
					updatedAt: timestamp,
				} as const
				database.putTranscriptionJob({
					...baseJob,
					fileId: AUDIO_FILE.id,
					filePath: AUDIO_FILE.path.join('/'),
					trigger: 'automatic',
				})
				database.putTranscriptionJob({
					...baseJob,
					fileId: SECOND_AUDIO_FILE.id,
					filePath: SECOND_AUDIO_FILE.path.join('/'),
					trigger: 'manual',
				})

				await manager.start()
				await waitForState(manager, 'completed', SECOND_AUDIO_FILE.id)
				expect(manager.get(INFO_HASH, AUDIO_FILE.id)).toMatchObject({
					error: { code: 'automatic_disabled' },
					state: 'cancelled',
				})
				expect(provider.calls).toBe(1)
			} finally {
				await manager.close()
				database.close()
				await rm(root, { force: true, recursive: true })
			}
		},
		TEST_TIMEOUT_MS
	)

	test(
		'recovers queued work but marks interrupted active work ambiguous without automatic replay',
		async () => {
			const root = await mkdtemp(join(tmpdir(), 'tplayer-transcription-'))
			const database = new AppDatabase(join(root, 'history.sqlite'))
			const torrentService = new FakeTorrentService([
				AUDIO_FILE,
				SECOND_AUDIO_FILE,
			])
			const provider = new ScriptedProvider([
				() => ({
					words: [{ endMs: 500, startMs: 300, text: 'Queued.' }],
				}),
			])
			const manager = createManager(
				database,
				torrentService,
				provider,
				new ScriptedTranscoder(
					[
						{
							inputStartMs: 0,
							logicalEndMs: 1000,
							logicalStartMs: 0,
							wav: Uint8Array.from([1]),
						},
					],
					1000
				)
			)
			try {
				makeLocal(database)
				database.setAutomaticTranscriptionEnabled(true)
				const timestamp = new Date().toISOString()
				const baseJob = {
					attempt: 1,
					createdAt: timestamp,
					errorAmbiguous: false,
					errorCode: null,
					errorMessage: null,
					errorRetryable: false,
					fileLength: AUDIO_FILE.length,
					finishedAt: null,
					infoHash: INFO_HASH,
					model: provider.model,
					processedMilliseconds: 0,
					provider: provider.id,
					startedAt: timestamp,
					totalMilliseconds: null,
					trigger: 'automatic',
					updatedAt: timestamp,
				} as const
				database.putTranscriptionJob({
					...baseJob,
					fileId: AUDIO_FILE.id,
					filePath: AUDIO_FILE.path.join('/'),
					state: 'preparing',
				})
				database.putTranscriptionJob({
					...baseJob,
					fileId: SECOND_AUDIO_FILE.id,
					filePath: SECOND_AUDIO_FILE.path.join('/'),
					startedAt: null,
					state: 'queued',
				})

				await manager.start()
				await waitForState(manager, 'completed', SECOND_AUDIO_FILE.id)
				expect(manager.get(INFO_HASH, AUDIO_FILE.id)).toMatchObject({
					attempt: 1,
					error: {
						ambiguous: true,
						code: 'server_interrupted',
						retryable: true,
					},
					state: 'failed',
				})
				expect(provider.calls).toBe(1)

				makeLocal(database, SECOND_INFO_HASH)
				torrentService.emitCacheCompleted(SECOND_INFO_HASH)
				await delay(20)
				expect(
					database
						.listTranscriptionJobs(SECOND_INFO_HASH)
						.some((job) => job.trigger === 'automatic')
				).toBe(true)
			} finally {
				await manager.close()
				database.close()
				await rm(root, { force: true, recursive: true })
			}
		},
		TEST_TIMEOUT_MS
	)
})

import { join } from 'node:path'
import type { TimedWord } from '@tplayer/captions/types'
import { serve } from 'bun'
import { createApp } from '../server/app'
import type { AppConfig } from '../server/config'
import type { AppLogger } from '../server/logger'
import { createAudiobookSearchService } from '../server/search/service'
import { SearchUpstreamHarness } from '../server/search/test/upstream'
import { delay, PrivateSwarmHarness } from '../server/test/harness'
import type {
	AudioTranscodeResult,
	AudioTranscoder,
	AudioWindow,
} from '../server/transcription/audioPipeline'
import { TranscriptionManager } from '../server/transcription/manager'
import {
	type SpeechProvider,
	SpeechProviderFailure,
	type SpeechTranscription,
	type SpeechTranscriptionOptions,
} from '../server/transcription/provider'

const DEFAULT_E2E_PORT = 4179
const LOOPBACK_HOST = '127.0.0.1'
const FILE_ROUTE_PATTERN = /^\/api\/torrents\/[^/]+\/files\/[^/]+$/
const OFFLINE_CACHE_PURPOSE = 'offline-cache'
const OFFLINE_CACHE_PURPOSE_HEADER = 'X-TPlayer-Purpose'
const DEFAULT_OFFLINE_CACHE_RANGE_DELAY_MS = 200
const MAXIMUM_RANGE_DELAY_MS = 10_000
const E2E_TRANSCRIPTION_TIMEOUT_MS = 12_000
const WAVE_HEADER_BYTES = 44
const MILLISECONDS_PER_SECOND = 1000
const LEGACY_SERVICE_WORKER = `
const legacyShell = '<!doctype html><html><body><main data-testid="legacy-shell">legacy app shell</main></body></html>'
const legacyCacheName = 'workbox-precache-v2-legacy-tplayer'

self.addEventListener('install', (event) => {
	event.waitUntil(
		caches.open(legacyCacheName).then((cache) =>
			cache.put(
				'/__e2e/legacy-shell',
				new Response(legacyShell, {
					headers: { 'Content-Type': 'text/html; charset=utf-8' },
				})
			)
		)
	)
})

self.addEventListener('fetch', (event) => {
	if (event.request.mode === 'navigate') {
		event.respondWith(caches.match('/__e2e/legacy-shell'))
	}
})
`
const LEGACY_WORKER_INSTALLER = `<!doctype html>
<html>
	<body data-worker-ready="false">
		<script>
			navigator.serviceWorker.register('/sw.js', { scope: '/' }).then(async () => {
				await navigator.serviceWorker.ready
				document.body.dataset.workerReady = 'true'
			})
		</script>
	</body>
</html>`

interface FileRequestMetric {
	contentLength: number
	contentRange: string | null
	method: string
	pathname: string
	purpose: string | null
	range: string | null
	status: number
}

interface RegistrationMetrics {
	searchResolveRequests: number
	torrentRegistrationRequests: number
}

interface RangeDelayConfiguration {
	offlineCacheRangeMs: number
	playbackRangeMs: number
}

type TranscriptionBehavior = 'cleanup-hold' | 'failure' | 'hold' | 'success'
type TranscriptionOutcome =
	| 'aborted'
	| 'cleanup_pending'
	| 'completed'
	| 'failed'
	| 'running'
type TranscoderBehavior = 'cleanup-hold' | 'hold' | 'success'

interface TranscriptionCallMetric {
	behavior: TranscriptionBehavior
	inputBytes: number
	outcome: TranscriptionOutcome
	sequence: number
}

interface TranscriptionControlBody {
	behaviors?: unknown
	nextWindowSplitMilliseconds?: unknown
	resetMetrics?: unknown
	transcoderBehaviors?: unknown
}

interface TranscriptionProviderSnapshot {
	calls: TranscriptionCallMetric[]
	inFlight: number
	queuedBehaviors: TranscriptionBehavior[]
}

interface TranscoderCallMetric {
	behavior: TranscoderBehavior
	outcome: TranscriptionOutcome
	sequence: number
}

interface TranscoderSnapshot {
	calls: TranscoderCallMetric[]
	inFlight: number
	queuedBehaviors: TranscoderBehavior[]
}

const abortError = (): Error => {
	const error = new Error('Deterministic transcription was cancelled')
	error.name = 'AbortError'
	return error
}

const throwIfAborted = (signal: AbortSignal): void => {
	if (signal.aborted) {
		throw abortError()
	}
}

class DeterministicCleanupGate {
	private pending:
		| {
				promise: Promise<void>
				resolve: () => void
		  }
		| undefined

	arm(): void {
		if (this.pending) {
			throw new Error('A deterministic cleanup release is already pending')
		}
		let resolve = (): void => undefined
		const promise = new Promise<void>((resolvePromise) => {
			resolve = resolvePromise
		})
		this.pending = { promise, resolve }
	}

	isPending(): boolean {
		return this.pending !== undefined
	}

	release(): boolean {
		const { pending } = this
		if (!pending) {
			return false
		}
		this.pending = undefined
		pending.resolve()
		return true
	}

	wait(): Promise<void> {
		if (!this.pending) {
			throw new Error('Deterministic cleanup was not armed')
		}
		return this.pending.promise
	}
}

const readEntireStream = async (
	source: ReadableStream<Uint8Array>,
	signal: AbortSignal
): Promise<{ header: Uint8Array; totalBytes: number }> => {
	const header = new Uint8Array(WAVE_HEADER_BYTES)
	let headerBytes = 0
	let totalBytes = 0
	let reading = true
	const reader = source.getReader()
	try {
		while (reading) {
			throwIfAborted(signal)
			// biome-ignore lint/performance/noAwaitInLoops: The deterministic transcoder consumes the local source with backpressure.
			const { done, value } = await reader.read()
			if (done) {
				reading = false
				continue
			}
			totalBytes += value.byteLength
			if (headerBytes < header.byteLength) {
				const retained = value.subarray(
					0,
					Math.min(value.byteLength, header.byteLength - headerBytes)
				)
				header.set(retained, headerBytes)
				headerBytes += retained.byteLength
			}
		}
	} finally {
		reader.releaseLock()
	}
	if (headerBytes < WAVE_HEADER_BYTES) {
		throw new Error('The deterministic audio fixture is missing its WAV header')
	}
	return { header, totalBytes }
}

const waveDurationMilliseconds = (
	header: Uint8Array,
	totalBytes: number
): number => {
	const view = new DataView(header.buffer, header.byteOffset, header.byteLength)
	const byteRate = view.getUint32(28, true)
	if (byteRate <= 0) {
		throw new Error('The deterministic audio fixture has an invalid byte rate')
	}
	return Math.floor(
		(Math.max(0, totalBytes - WAVE_HEADER_BYTES) * MILLISECONDS_PER_SECOND) /
			byteRate
	)
}

const waveHeaderForDuration = (
	header: Uint8Array,
	durationMilliseconds: number
): Uint8Array => {
	const windowHeader = header.slice()
	const view = new DataView(
		windowHeader.buffer,
		windowHeader.byteOffset,
		windowHeader.byteLength
	)
	const byteRate = view.getUint32(28, true)
	const blockAlign = view.getUint16(32, true)
	if (byteRate <= 0 || blockAlign <= 0) {
		throw new Error('The deterministic audio fixture has an invalid format')
	}
	const unalignedDataBytes = Math.floor(
		(durationMilliseconds * byteRate) / MILLISECONDS_PER_SECOND
	)
	const dataBytes = Math.floor(unalignedDataBytes / blockAlign) * blockAlign
	view.setUint32(4, WAVE_HEADER_BYTES + dataBytes - 8, true)
	view.setUint32(40, dataBytes, true)
	return windowHeader
}

class DeterministicAudioTranscoder implements AudioTranscoder {
	private behaviors: TranscoderBehavior[] = []
	private readonly calls: TranscoderCallMetric[] = []
	private inFlight = 0
	private nextWindowSplitMilliseconds: number | null = null
	private readonly cleanupGate: DeterministicCleanupGate

	constructor(cleanupGate: DeterministicCleanupGate) {
		this.cleanupGate = cleanupGate
	}

	configure(
		behaviors: readonly TranscoderBehavior[],
		resetMetrics: boolean
	): void {
		this.behaviors = [...behaviors]
		if (resetMetrics) {
			this.calls.length = 0
		}
	}

	configureNextWindowSplit(milliseconds: number | null): void {
		this.nextWindowSplitMilliseconds = milliseconds
	}

	snapshot(): TranscoderSnapshot {
		return {
			calls: this.calls.map((call) => ({ ...call })),
			inFlight: this.inFlight,
			queuedBehaviors: [...this.behaviors],
		}
	}

	async transcode(
		source: ReadableStream<Uint8Array>,
		signal: AbortSignal,
		onWindow: (window: AudioWindow) => Promise<void>
	): Promise<AudioTranscodeResult> {
		const behavior = this.behaviors.shift() ?? 'success'
		const call: TranscoderCallMetric = {
			behavior,
			outcome: 'running',
			sequence: this.calls.length + 1,
		}
		this.calls.push(call)
		this.inFlight += 1
		const splitMilliseconds = this.nextWindowSplitMilliseconds
		this.nextWindowSplitMilliseconds = null
		try {
			const { header, totalBytes } = await readEntireStream(source, signal)
			const durationMs = waveDurationMilliseconds(header, totalBytes)
			throwIfAborted(signal)
			if (behavior === 'hold') {
				await waitForAbort(signal)
			}
			if (behavior === 'cleanup-hold') {
				try {
					await onWindow({
						inputStartMs: 0,
						logicalEndMs: durationMs,
						logicalStartMs: 0,
						wav: header,
					})
					await waitForAbort(signal)
				} catch (error) {
					if (
						signal.aborted ||
						(error instanceof Error && error.name === 'AbortError')
					) {
						call.outcome = 'cleanup_pending'
						await this.cleanupGate.wait()
					}
					throw error
				}
			}
			if (splitMilliseconds !== null) {
				if (splitMilliseconds >= durationMs) {
					throw new Error(
						`The deterministic window split ${splitMilliseconds}ms must be shorter than ${durationMs}ms`
					)
				}
				await onWindow({
					inputStartMs: 0,
					logicalEndMs: splitMilliseconds,
					logicalStartMs: 0,
					wav: waveHeaderForDuration(header, splitMilliseconds),
				})
				throwIfAborted(signal)
				await onWindow({
					inputStartMs: splitMilliseconds,
					logicalEndMs: durationMs,
					logicalStartMs: splitMilliseconds,
					wav: waveHeaderForDuration(header, durationMs - splitMilliseconds),
				})
				call.outcome = 'completed'
				return { durationMs }
			}
			await onWindow({
				inputStartMs: 0,
				logicalEndMs: durationMs,
				logicalStartMs: 0,
				wav: header,
			})
			call.outcome = 'completed'
			return { durationMs }
		} catch (error) {
			call.outcome =
				error instanceof Error && error.name === 'AbortError'
					? 'aborted'
					: 'failed'
			throw error
		} finally {
			this.inFlight -= 1
		}
	}
}

const phraseWords = (startMs: number, words: readonly string[]): TimedWord[] =>
	words.map((text, index) => ({
		confidence: 0.99,
		endMs: startMs + index * 400 + 360,
		startMs: startMs + index * 400,
		text,
	}))

const deterministicWords = (durationMs: number): TimedWord[] => {
	const middleStart = Math.max(6500, Math.floor(durationMs / 2))
	const finalStart = Math.max(middleStart + 6500, durationMs - 6000)
	return [
		...phraseWords(0, ['Private', 'swarm', 'captions', 'stay', 'local.']),
		...phraseWords(3000, ['Playback', 'remains', 'responsive.']),
		...phraseWords(middleStart, ['Seeking', 'keeps', 'captions', 'aligned.']),
		...phraseWords(finalStart, ['Offline', 'captions', 'remain', 'available.']),
	].filter((word) => word.endMs < durationMs)
}

const durationFromWaveHeader = (wav: Uint8Array): number => {
	if (wav.byteLength < WAVE_HEADER_BYTES) {
		throw new Error('The deterministic provider received an invalid WAV window')
	}
	const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength)
	const dataBytes = view.getUint32(40, true)
	const byteRate = view.getUint32(28, true)
	if (byteRate <= 0) {
		throw new Error('The deterministic provider received an invalid byte rate')
	}
	return Math.floor((dataBytes * MILLISECONDS_PER_SECOND) / byteRate)
}

const waitForAbort = async (signal: AbortSignal): Promise<never> => {
	throwIfAborted(signal)
	return await new Promise<never>((_resolve, reject) => {
		signal.addEventListener('abort', () => reject(abortError()), { once: true })
	})
}

class DeterministicSpeechProvider implements SpeechProvider {
	readonly id = 'e2e-deterministic'
	readonly model = 'fixture-v1'
	private readonly calls: TranscriptionCallMetric[] = []
	private behaviors: TranscriptionBehavior[] = []
	private readonly cleanupGate: DeterministicCleanupGate
	private inFlight = 0

	constructor(cleanupGate: DeterministicCleanupGate) {
		this.cleanupGate = cleanupGate
	}

	configure(
		behaviors: readonly TranscriptionBehavior[],
		resetMetrics: boolean
	): void {
		this.behaviors = [...behaviors]
		if (resetMetrics) {
			this.calls.length = 0
		}
	}

	snapshot(): TranscriptionProviderSnapshot {
		return {
			calls: this.calls.map((call) => ({ ...call })),
			inFlight: this.inFlight,
			queuedBehaviors: [...this.behaviors],
		}
	}

	async transcribe(
		wav: Uint8Array,
		options: SpeechTranscriptionOptions
	): Promise<SpeechTranscription> {
		const behavior = this.behaviors.shift() ?? 'success'
		const call: TranscriptionCallMetric = {
			behavior,
			inputBytes: wav.byteLength,
			outcome: 'running',
			sequence: this.calls.length + 1,
		}
		this.calls.push(call)
		this.inFlight += 1
		try {
			throwIfAborted(options.signal)
			if (behavior === 'hold') {
				await waitForAbort(options.signal)
			}
			if (behavior === 'cleanup-hold') {
				try {
					await waitForAbort(options.signal)
				} catch (error) {
					if (error instanceof Error && error.name === 'AbortError') {
						call.outcome = 'cleanup_pending'
						await this.cleanupGate.wait()
					}
					throw error
				}
			}
			if (behavior === 'failure') {
				throw new SpeechProviderFailure(
					'e2e_provider_failure',
					'Deterministic transcription failure.',
					{ retryable: true }
				)
			}
			call.outcome = 'completed'
			return {
				language: 'en',
				words: deterministicWords(durationFromWaveHeader(wav)),
			}
		} catch (error) {
			call.outcome =
				error instanceof Error && error.name === 'AbortError'
					? 'aborted'
					: 'failed'
			throw error
		} finally {
			this.inFlight -= 1
		}
	}
}

const logger: AppLogger = {
	debug: () => undefined,
	error: (message, context) => {
		process.stderr.write(
			`E2E server error: ${message} ${JSON.stringify(context ?? {})}\n`
		)
	},
	info: () => undefined,
	warn: () => undefined,
}

const configuredPort = (): number => {
	const value = Number(process.env.TPLAYER_E2E_PORT ?? DEFAULT_E2E_PORT)
	if (!Number.isInteger(value) || value <= 0 || value > 65_535) {
		throw new Error(`Invalid TPLAYER_E2E_PORT: ${String(value)}`)
	}
	return value
}

const harness = await PrivateSwarmHarness.start(60_000)
const searchUpstream = SearchUpstreamHarness.start(
	harness.infoHash,
	'private-swarm-audiobook'
)
const transcriptionCleanupGate = new DeterministicCleanupGate()
const speechProvider = new DeterministicSpeechProvider(transcriptionCleanupGate)
const audioTranscoder = new DeterministicAudioTranscoder(
	transcriptionCleanupGate
)
const transcriptions = new TranscriptionManager({
	config: {
		...harness.config.transcription,
		requestTimeoutMs: E2E_TRANSCRIPTION_TIMEOUT_MS,
	},
	database: harness.database,
	logger,
	provider: speechProvider,
	torrentManager: harness.manager,
	transcoder: audioTranscoder,
})
await transcriptions.start()
const frontendDirectory = join(import.meta.dir, '..', 'dist')
const config: AppConfig = {
	...harness.config,
	frontendDirectory,
	listen: { hostname: LOOPBACK_HOST, port: configuredPort() },
}
const app = createApp({
	config,
	database: harness.database,
	logger,
	manager: harness.manager,
	searchService: createAudiobookSearchService({
		endpoints: searchUpstream.endpoints,
	}),
	transcriptions,
})
const fileRequests: FileRequestMetric[] = []
const registrationMetrics: RegistrationMetrics = {
	searchResolveRequests: 0,
	torrentRegistrationRequests: 0,
}
let resourcesClosed = false
let serveLegacyServiceWorker = false
let rangeDelays: RangeDelayConfiguration = {
	offlineCacheRangeMs: DEFAULT_OFFLINE_CACHE_RANGE_DELAY_MS,
	playbackRangeMs: 0,
}

const closeResources = async (): Promise<void> => {
	if (resourcesClosed) {
		return
	}
	resourcesClosed = true
	try {
		await transcriptions.close()
	} finally {
		try {
			searchUpstream.close()
		} finally {
			await harness.close()
		}
	}
}

const fixtureResponse = (): Response =>
	Response.json({
		files: harness.fixture.files.map(({ bytes, name, path, sha256 }) => ({
			bytes: bytes.byteLength,
			name,
			path,
			sha256,
		})),
		infoHash: harness.infoHash,
		magnetUri: harness.magnetUri,
		name: 'private-swarm-audiobook',
		totalBytes: harness.fixture.totalBytes,
	})

const metricsResponse = async (): Promise<Response> => {
	const torrent = await harness.downloader.get(harness.infoHash)
	return Response.json({
		downloaderDownloadedBytes: torrent?.downloaded ?? 0,
		fileRequests,
		manager: harness.manager.health(),
		seederUploadedBytes: harness.seedTorrent.uploaded,
	})
}

const validatedDelay = (value: unknown): number | null => {
	const delayMilliseconds = Number(value)
	return Number.isInteger(delayMilliseconds) &&
		delayMilliseconds >= 0 &&
		delayMilliseconds <= MAXIMUM_RANGE_DELAY_MS
		? delayMilliseconds
		: null
}

const updateRangeDelays = async (request: Request): Promise<Response> => {
	const requested = (await request.json()) as Partial<RangeDelayConfiguration>
	const offlineCacheRangeMs = validatedDelay(requested.offlineCacheRangeMs)
	const playbackRangeMs = validatedDelay(requested.playbackRangeMs)
	if (offlineCacheRangeMs === null || playbackRangeMs === null) {
		return Response.json({ error: 'Invalid range delay' }, { status: 400 })
	}
	rangeDelays = { offlineCacheRangeMs, playbackRangeMs }
	return Response.json(rangeDelays)
}

const isTranscriptionBehavior = (
	value: unknown
): value is TranscriptionBehavior =>
	value === 'cleanup-hold' ||
	value === 'failure' ||
	value === 'hold' ||
	value === 'success'

const isTranscriptionBehaviorList = (
	value: unknown
): value is TranscriptionBehavior[] =>
	Array.isArray(value) && value.every(isTranscriptionBehavior)

const isTranscoderBehavior = (value: unknown): value is TranscoderBehavior =>
	value === 'cleanup-hold' || value === 'hold' || value === 'success'

const isTranscoderBehaviorList = (
	value: unknown
): value is TranscoderBehavior[] =>
	Array.isArray(value) && value.every(isTranscoderBehavior)

const updateTranscriptionControl = async (
	request: Request
): Promise<Response> => {
	const body = (await request.json()) as TranscriptionControlBody
	const { behaviors } = body
	if (behaviors !== undefined && !isTranscriptionBehaviorList(behaviors)) {
		return Response.json(
			{
				error: 'behaviors must contain success, failure, hold, or cleanup-hold',
			},
			{ status: 400 }
		)
	}
	if (
		body.transcoderBehaviors !== undefined &&
		!isTranscoderBehaviorList(body.transcoderBehaviors)
	) {
		return Response.json(
			{
				error:
					'transcoderBehaviors must contain success, hold, or cleanup-hold',
			},
			{ status: 400 }
		)
	}
	if (
		body.nextWindowSplitMilliseconds !== undefined &&
		!(
			Number.isSafeInteger(body.nextWindowSplitMilliseconds) &&
			Number(body.nextWindowSplitMilliseconds) > 0
		)
	) {
		return Response.json(
			{ error: 'nextWindowSplitMilliseconds must be a positive integer' },
			{ status: 400 }
		)
	}
	if (
		behaviors?.includes('cleanup-hold') ||
		body.transcoderBehaviors?.includes('cleanup-hold')
	) {
		transcriptionCleanupGate.arm()
	}
	if (
		body.resetMetrics !== undefined &&
		typeof body.resetMetrics !== 'boolean'
	) {
		return Response.json(
			{ error: 'resetMetrics must be a boolean' },
			{ status: 400 }
		)
	}
	audioTranscoder.configureNextWindowSplit(
		body.nextWindowSplitMilliseconds === undefined
			? null
			: Number(body.nextWindowSplitMilliseconds)
	)
	audioTranscoder.configure(
		body.transcoderBehaviors ?? [],
		body.resetMetrics === true
	)
	speechProvider.configure(behaviors ?? [], body.resetMetrics === true)
	return Response.json({
		...speechProvider.snapshot(),
		transcoder: audioTranscoder.snapshot(),
	})
}

const transcriptionFixtureResponse = async (
	pathname: string,
	request: Request
): Promise<Response | null> => {
	if (pathname === '/__e2e/transcription-metrics') {
		return Response.json({
			cleanupReleasePending: transcriptionCleanupGate.isPending(),
			...speechProvider.snapshot(),
			manager: transcriptions.health(),
			transcoder: audioTranscoder.snapshot(),
		})
	}
	if (
		pathname === '/__e2e/transcription-release-cleanup' &&
		request.method === 'POST'
	) {
		return Response.json({ released: transcriptionCleanupGate.release() })
	}
	if (
		pathname === '/__e2e/transcription-control' &&
		request.method === 'POST'
	) {
		return await updateTranscriptionControl(request)
	}
	return null
}

const delayFileRange = async (
	request: Request,
	response: Response
): Promise<void> => {
	const isFileRange =
		request.method === 'GET' &&
		response.status === 206 &&
		request.headers.has('range')
	if (!isFileRange) {
		return
	}
	const delayMilliseconds =
		request.headers.get(OFFLINE_CACHE_PURPOSE_HEADER) === OFFLINE_CACHE_PURPOSE
			? rangeDelays.offlineCacheRangeMs
			: rangeDelays.playbackRangeMs
	if (delayMilliseconds > 0) {
		await delay(delayMilliseconds)
	}
}

const fetch = async (request: Request): Promise<Response> => {
	const { pathname } = new URL(request.url)
	const transcriptionResponse = await transcriptionFixtureResponse(
		pathname,
		request
	)
	if (transcriptionResponse) {
		return transcriptionResponse
	}
	if (pathname === '/sw.js' && serveLegacyServiceWorker) {
		return new Response(LEGACY_SERVICE_WORKER, {
			headers: {
				'Cache-Control': 'no-cache, no-store, must-revalidate',
				'Content-Type': 'text/javascript; charset=utf-8',
			},
		})
	}
	if (pathname === '/__e2e/install-legacy-worker') {
		return new Response(LEGACY_WORKER_INSTALLER, {
			headers: { 'Content-Type': 'text/html; charset=utf-8' },
		})
	}
	if (pathname === '/__e2e/service-worker-mode' && request.method === 'POST') {
		const body = (await request.json()) as { legacy?: unknown }
		serveLegacyServiceWorker = body.legacy === true
		return Response.json({ legacy: serveLegacyServiceWorker })
	}
	if (pathname === '/__e2e/fixture') {
		return fixtureResponse()
	}
	if (pathname === '/__e2e/metrics') {
		return await metricsResponse()
	}
	if (pathname === '/__e2e/search-metrics') {
		return Response.json(searchUpstream.snapshot())
	}
	if (pathname === '/__e2e/registration-metrics') {
		return Response.json(registrationMetrics)
	}
	if (pathname === '/__e2e/range-delays' && request.method === 'POST') {
		return await updateRangeDelays(request)
	}
	if (pathname === '/__e2e/cleanup' && request.method === 'POST') {
		await closeResources()
		return new Response(null, { status: 204 })
	}

	if (request.method === 'POST' && pathname === '/api/search/resolve') {
		registrationMetrics.searchResolveRequests += 1
	}
	if (request.method === 'POST' && pathname === '/api/torrents') {
		registrationMetrics.torrentRegistrationRequests += 1
	}
	const response = await app.fetch(request)
	if (FILE_ROUTE_PATTERN.test(pathname)) {
		fileRequests.push({
			contentLength: Number(response.headers.get('content-length') ?? 0),
			contentRange: response.headers.get('content-range'),
			method: request.method,
			pathname,
			purpose: request.headers.get(OFFLINE_CACHE_PURPOSE_HEADER),
			range: request.headers.get('range'),
			status: response.status,
		})
		await delayFileRange(request, response)
	}
	return response
}

const server = serve({
	fetch,
	hostname: config.listen.hostname,
	port: config.listen.port,
})

let stopping = false
const shutdown = async (exitCode: number): Promise<void> => {
	if (stopping) {
		return
	}
	stopping = true
	server.stop(true)
	try {
		await closeResources()
	} finally {
		process.exit(exitCode)
	}
}

process.once('SIGINT', async () => {
	await shutdown(0)
})
process.once('SIGTERM', async () => {
	await shutdown(0)
})

process.stdout.write(`E2E server listening at ${server.url.href}\n`)

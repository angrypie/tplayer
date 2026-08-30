import { join } from 'node:path'
import { serve } from 'bun'
import { createApp } from '../server/app'
import type { AppConfig } from '../server/config'
import type { AppLogger } from '../server/logger'
import { createAudiobookSearchService } from '../server/search/service'
import { SearchUpstreamHarness } from '../server/search/test/upstream'
import { delay, PrivateSwarmHarness } from '../server/test/harness'

const DEFAULT_E2E_PORT = 4179
const LOOPBACK_HOST = '127.0.0.1'
const FILE_ROUTE_PATTERN = /^\/api\/torrents\/[^/]+\/files\/[^/]+$/
const OFFLINE_CACHE_PURPOSE = 'offline-cache'
const OFFLINE_CACHE_PURPOSE_HEADER = 'X-TPlayer-Purpose'
const DEFAULT_OFFLINE_CACHE_RANGE_DELAY_MS = 200
const MAXIMUM_RANGE_DELAY_MS = 10_000
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
		searchUpstream.close()
	} finally {
		await harness.close()
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

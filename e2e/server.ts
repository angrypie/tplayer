import { join } from 'node:path'
import { serve } from 'bun'
import { createApp } from '../server/app'
import type { AppConfig } from '../server/config'
import type { AppLogger } from '../server/logger'
import { createAudiobookSearchService } from '../server/search/service'
import { SearchUpstreamHarness } from '../server/search/test/upstream'
import { PrivateSwarmHarness } from '../server/test/harness'

const DEFAULT_E2E_PORT = 4179
const LOOPBACK_HOST = '127.0.0.1'
const FILE_ROUTE_PATTERN = /^\/api\/torrents\/[^/]+\/files\/[^/]+$/

interface FileRequestMetric {
	contentLength: number
	contentRange: string | null
	method: string
	range: string | null
	status: number
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
let resourcesClosed = false

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

const fetch = async (request: Request): Promise<Response> => {
	const { pathname } = new URL(request.url)
	if (pathname === '/__e2e/fixture') {
		return fixtureResponse()
	}
	if (pathname === '/__e2e/metrics') {
		return await metricsResponse()
	}
	if (pathname === '/__e2e/search-metrics') {
		return Response.json(searchUpstream.snapshot())
	}
	if (pathname === '/__e2e/cleanup' && request.method === 'POST') {
		await closeResources()
		return new Response(null, { status: 204 })
	}

	const response = await app.fetch(request)
	if (FILE_ROUTE_PATTERN.test(pathname)) {
		fileRequests.push({
			contentLength: Number(response.headers.get('content-length') ?? 0),
			contentRange: response.headers.get('content-range'),
			method: request.method,
			range: request.headers.get('range'),
			status: response.status,
		})
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

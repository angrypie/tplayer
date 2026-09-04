import { resolve } from 'node:path'
import { version as bunVersion } from 'bun'

const DEFAULT_CACHE_CAPACITY_BYTES = 10 * 1024 * 1024 * 1024
const DEFAULT_GRACE_MS = 60_000
const DEFAULT_METADATA_TIMEOUT_MS = 90_000
const DEFAULT_TORRENT_PORT = 42_069
const DEFAULT_TRANSCRIPTION_TIMEOUT_MS = 10 * 60 * 1000
const MAXIMUM_TIMER_DELAY_MS = 2_147_483_647
export const applicationRoot = resolve(import.meta.dir, '..')

export interface ListenAddress {
	hostname: string
	port: number
}

export interface TorrentRuntimeConfig {
	cacheCapacityBytes: number
	cacheDirectory: string
	dht: boolean
	graceMs: number
	localServiceDiscovery: boolean
	maxConnections: number
	metadataTimeoutMs: number
	peerExchange: boolean
	torrentPort: number
	trackers: boolean
	utp: boolean
}

export interface TranscriptionRuntimeConfig {
	ffmpegPath: string
	requestTimeoutMs: number
}

export interface AppConfig {
	databasePath: string
	frontendDirectory: string
	listen: ListenAddress
	serveFrontend: boolean
	torrent: TorrentRuntimeConfig
	transcription: TranscriptionRuntimeConfig
}

const parseBoolean = (
	value: string | undefined,
	fallback: boolean
): boolean => {
	if (value === undefined) {
		return fallback
	}
	return !['0', 'false', 'no', 'off'].includes(value.toLowerCase())
}

const parsePositiveInteger = (
	value: string | undefined,
	fallback: number,
	name: string
): number => {
	if (value === undefined) {
		return fallback
	}
	const parsed = Number(value)
	if (!(Number.isSafeInteger(parsed) && parsed > 0)) {
		throw new Error(`${name} must be a positive integer`)
	}
	return parsed
}

const resolveApplicationPath = (
	value: string | undefined,
	fallback: string
): string => resolve(applicationRoot, value ?? fallback)

export const parseListenAddress = (value: string): ListenAddress => {
	const trimmed = value.trim()
	const hostAndPort = trimmed.startsWith(':') ? `0.0.0.0${trimmed}` : trimmed
	const normalized = hostAndPort.includes('://')
		? hostAndPort
		: `http://${hostAndPort}`
	if (!URL.canParse(normalized)) {
		throw new Error('TPLAYER_LISTEN_ADDR must use the host:port format')
	}
	const url = new URL(normalized)
	const port = Number(url.port)
	if (!(Number.isInteger(port) && port > 0 && port <= 65_535)) {
		throw new Error('TPLAYER_LISTEN_ADDR must include a valid port')
	}
	return {
		hostname: url.hostname,
		port,
	}
}

export const loadConfig = (
	environment: NodeJS.ProcessEnv = process.env
): AppConfig => {
	const utp = parseBoolean(environment.TPLAYER_UTP, false)
	if (utp && bunVersion.startsWith('1.4.')) {
		throw new Error(
			'TPLAYER_UTP is unsupported on Bun 1.4; TCP transport remains enabled'
		)
	}

	return {
		databasePath: resolveApplicationPath(
			environment.TPLAYER_DATABASE_PATH,
			'tplayer_history.sqlite'
		),
		frontendDirectory: resolveApplicationPath(
			environment.TPLAYER_FRONTEND_DIR,
			'dist'
		),
		listen: parseListenAddress(
			environment.TPLAYER_LISTEN_ADDR ?? '127.0.0.1:8082'
		),
		serveFrontend: parseBoolean(environment.TPLAYER_SERVE_FRONTEND, true),
		torrent: {
			cacheCapacityBytes: parsePositiveInteger(
				environment.TPLAYER_CACHE_CAPACITY_BYTES,
				DEFAULT_CACHE_CAPACITY_BYTES,
				'TPLAYER_CACHE_CAPACITY_BYTES'
			),
			cacheDirectory: resolveApplicationPath(
				environment.TPLAYER_CACHE_DIR,
				'tplayer-cache'
			),
			dht: parseBoolean(environment.TPLAYER_DHT, true),
			graceMs: parsePositiveInteger(
				environment.TPLAYER_TORRENT_GRACE_MS,
				DEFAULT_GRACE_MS,
				'TPLAYER_TORRENT_GRACE_MS'
			),
			localServiceDiscovery: parseBoolean(environment.TPLAYER_LSD, true),
			maxConnections: parsePositiveInteger(
				environment.TPLAYER_MAX_CONNECTIONS,
				55,
				'TPLAYER_MAX_CONNECTIONS'
			),
			metadataTimeoutMs: parsePositiveInteger(
				environment.TPLAYER_METADATA_TIMEOUT_MS,
				DEFAULT_METADATA_TIMEOUT_MS,
				'TPLAYER_METADATA_TIMEOUT_MS'
			),
			peerExchange: parseBoolean(environment.TPLAYER_PEX, true),
			torrentPort: parsePositiveInteger(
				environment.TPLAYER_TORRENT_PORT,
				DEFAULT_TORRENT_PORT,
				'TPLAYER_TORRENT_PORT'
			),
			trackers: parseBoolean(environment.TPLAYER_TRACKERS, true),
			// utp-native 2.5 calls uv_timer_init, which Bun 1.4 does not support.
			// TCP remains enabled and is WebTorrent's stable Bun transport.
			utp,
		},
		transcription: {
			ffmpegPath: environment.TPLAYER_FFMPEG_PATH?.trim() || 'ffmpeg',
			requestTimeoutMs: parseTranscriptionTimeout(
				environment.TPLAYER_TRANSCRIPTION_TIMEOUT_MS,
				DEFAULT_TRANSCRIPTION_TIMEOUT_MS
			),
		},
	}
}

const parseTranscriptionTimeout = (
	value: string | undefined,
	fallback: number
): number => {
	const timeout = parsePositiveInteger(
		value,
		fallback,
		'TPLAYER_TRANSCRIPTION_TIMEOUT_MS'
	)
	if (timeout > MAXIMUM_TIMER_DELAY_MS) {
		throw new Error(
			`TPLAYER_TRANSCRIPTION_TIMEOUT_MS must be at most ${MAXIMUM_TIMER_DELAY_MS}`
		)
	}
	return timeout
}

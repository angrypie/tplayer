import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Hono } from 'hono'
import WebTorrent, { type Torrent } from 'webtorrent'
import { createApp } from '../app'
import type { AppConfig, TorrentRuntimeConfig } from '../config'
import { AppDatabase } from '../database'
import type { AppLogger } from '../logger'
import { TorrentManager } from '../torrent/manager'

const DEFAULT_WAIT_TIMEOUT_MS = 10_000
const FIXTURE_MIB = 1024 * 1024
const PCM_BITS_PER_SAMPLE = 16
const PCM_BLOCK_ALIGN = PCM_BITS_PER_SAMPLE / 8
const PCM_CHANNELS = 1
const PCM_HEADER_BYTES = 44
const PCM_SAMPLE_RATE = 44_100
const PCM_AMPLITUDE = 12_000
const TINY_PNG_BASE64 =
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nxoAAAAASUVORK5CYII='

export interface FixtureFile {
	bytes: Uint8Array
	id?: string
	name: string
	path: string
	sha256: string
}

export interface TorrentFixture {
	directory: string
	files: FixtureFile[]
	totalBytes: number
}

export interface ReadMetrics {
	body: Uint8Array
	durationMs: number
	firstByteMs: number
	throughputMiBPerSecond: number
}

const createCapturedLogger = (errors: string[]): AppLogger => ({
	debug: () => undefined,
	error: (message, context) => {
		errors.push(`${message}: ${JSON.stringify(context ?? {})}`)
	},
	info: () => undefined,
	warn: () => undefined,
})

const createClient = (): WebTorrent =>
	new WebTorrent({
		dht: false,
		lsd: false,
		natPmp: false,
		natUpnp: false,
		torrentPort: 0,
		tracker: false,
		utPex: false,
		utp: false,
	})

const writeAscii = (bytes: Uint8Array, offset: number, value: string): void => {
	bytes.set(new TextEncoder().encode(value), offset)
}

const createWaveAudio = (length: number, frequency: number): Uint8Array => {
	const dataLength = length - PCM_HEADER_BYTES
	if (dataLength <= 0 || dataLength % PCM_BLOCK_ALIGN !== 0) {
		throw new Error(`Invalid PCM fixture length ${length}`)
	}
	const bytes = new Uint8Array(length)
	const view = new DataView(bytes.buffer)
	writeAscii(bytes, 0, 'RIFF')
	view.setUint32(4, length - 8, true)
	writeAscii(bytes, 8, 'WAVE')
	writeAscii(bytes, 12, 'fmt ')
	view.setUint32(16, 16, true)
	view.setUint16(20, 1, true)
	view.setUint16(22, PCM_CHANNELS, true)
	view.setUint32(24, PCM_SAMPLE_RATE, true)
	view.setUint32(28, PCM_SAMPLE_RATE * PCM_BLOCK_ALIGN, true)
	view.setUint16(32, PCM_BLOCK_ALIGN, true)
	view.setUint16(34, PCM_BITS_PER_SAMPLE, true)
	writeAscii(bytes, 36, 'data')
	view.setUint32(40, dataLength, true)
	const sampleCount = dataLength / PCM_BLOCK_ALIGN
	for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
		const phase = (2 * Math.PI * frequency * sampleIndex) / PCM_SAMPLE_RATE
		view.setInt16(
			PCM_HEADER_BYTES + sampleIndex * PCM_BLOCK_ALIGN,
			Math.round(Math.sin(phase) * PCM_AMPLITUDE),
			true
		)
	}
	return bytes
}

const createCoverPng = (): Uint8Array =>
	new Uint8Array(Buffer.from(TINY_PNG_BASE64, 'base64'))

export const sha256 = (bytes: Uint8Array): string =>
	createHash('sha256').update(bytes).digest('hex')

const writeFixtureFile = async (
	directory: string,
	path: string,
	bytes: Uint8Array
): Promise<FixtureFile> => {
	const absolutePath = join(directory, path)
	await mkdir(dirname(absolutePath), { recursive: true })
	await writeFile(absolutePath, bytes)
	return {
		bytes,
		name: path.split('/').at(-1) ?? path,
		path,
		sha256: sha256(bytes),
	}
}

const createFixture = async (root: string): Promise<TorrentFixture> => {
	const directory = join(root, 'private-swarm-audiobook')
	const files = await Promise.all([
		writeFixtureFile(
			directory,
			'01 - Intro & basics.wav',
			createWaveAudio(8 * FIXTURE_MIB, 220)
		),
		writeFixtureFile(
			directory,
			'Part Ω/02 # Deep Dive.wav',
			createWaveAudio(4 * FIXTURE_MIB, 330)
		),
		writeFixtureFile(directory, 'cover.png', createCoverPng()),
	])
	return {
		directory,
		files,
		totalBytes: files.reduce((total, file) => total + file.bytes.byteLength, 0),
	}
}

export const delay = async (milliseconds: number): Promise<void> => {
	await new Promise<void>((resolve) => {
		setTimeout(resolve, milliseconds)
	})
}

const waitFor = async (
	predicate: () => boolean,
	description: string,
	timeoutMs = DEFAULT_WAIT_TIMEOUT_MS,
	startedAt = performance.now()
): Promise<void> => {
	if (predicate()) {
		return
	}
	if (performance.now() - startedAt >= timeoutMs) {
		throw new Error(`Timed out waiting for ${description}`)
	}
	await delay(10)
	await waitFor(predicate, description, timeoutMs, startedAt)
}

const seedFixture = async (
	client: WebTorrent,
	fixture: TorrentFixture
): Promise<Torrent> => {
	await waitFor(() => client.listening, 'the seeder TCP listener')
	return await new Promise<Torrent>((resolve, reject) => {
		const torrent = client.seed(
			fixture.directory,
			{ announce: [], deselect: false },
			(value) => {
				torrent.off('error', onError)
				resolve(value)
			}
		)
		const onError = (error: Error | string): void => {
			torrent.off('error', onError)
			reject(error instanceof Error ? error : new Error(error))
		}
		torrent.once('error', onError)
	})
}

const destroyClient = async (client: WebTorrent): Promise<void> => {
	if (client.destroyed) {
		return
	}
	await new Promise<void>((resolve, reject) => {
		client.destroy((error) => {
			if (error) {
				reject(error)
				return
			}
			resolve()
		})
	})
}

const torrentConfig = (
	root: string,
	graceMs: number
): TorrentRuntimeConfig => ({
	cacheCapacityBytes: 64 * FIXTURE_MIB,
	cacheDirectory: join(root, 'cache'),
	dht: false,
	graceMs,
	localServiceDiscovery: false,
	maxConnections: 16,
	metadataTimeoutMs: DEFAULT_WAIT_TIMEOUT_MS,
	peerExchange: false,
	torrentPort: 0,
	trackers: false,
	utp: false,
})

const appConfig = (root: string, torrent: TorrentRuntimeConfig): AppConfig => ({
	databasePath: join(root, 'history.sqlite'),
	frontendDirectory: root,
	listen: { hostname: '127.0.0.1', port: 0 },
	serveFrontend: false,
	torrent,
})

export class PrivateSwarmHarness {
	app: Hono
	readonly config: AppConfig
	readonly database: AppDatabase
	downloader: WebTorrent
	readonly errors: string[]
	readonly fixture: TorrentFixture
	readonly infoHash: string
	manager: TorrentManager
	readonly magnetUri: string
	readonly root: string
	readonly seedTorrent: Torrent
	private readonly seeder: WebTorrent
	private seederStopped: boolean

	private constructor(
		root: string,
		fixture: TorrentFixture,
		seeder: WebTorrent,
		seedTorrent: Torrent,
		database: AppDatabase,
		config: AppConfig,
		downloader: WebTorrent,
		errors: string[],
		manager: TorrentManager,
		app: Hono
	) {
		this.root = root
		this.fixture = fixture
		this.seeder = seeder
		this.seedTorrent = seedTorrent
		this.infoHash = seedTorrent.infoHash
		this.magnetUri = seedTorrent.magnetURI
		this.database = database
		this.config = config
		this.downloader = downloader
		this.errors = errors
		this.manager = manager
		this.app = app
		this.seederStopped = false
	}

	static async start(graceMs = 100): Promise<PrivateSwarmHarness> {
		const root = await mkdtemp(join(tmpdir(), 'tplayer-private-swarm-'))
		const fixture = await createFixture(root)
		const seeder = createClient()
		const seedTorrent = await seedFixture(seeder, fixture)
		const address = seeder.address()
		if (!(address && typeof address === 'object')) {
			throw new Error('Seeder did not expose a TCP address')
		}
		const manualPeer = `127.0.0.1:${address.port}`
		const config = appConfig(root, torrentConfig(root, graceMs))
		const database = new AppDatabase(config.databasePath)
		const downloader = createClient()
		const errors: string[] = []
		const logger = createCapturedLogger(errors)
		downloader.on('add', (torrent) => {
			const pendingTorrent = torrent as Torrent & { infoHash: string | null }
			const addManualPeer = (): void => {
				if (!torrent.addPeer(manualPeer, 'manual')) {
					throw new Error(`Unable to add private swarm peer ${manualPeer}`)
				}
			}
			if (pendingTorrent.infoHash) {
				addManualPeer()
			} else {
				torrent.once('infoHash', addManualPeer)
			}
		})
		const manager = new TorrentManager({
			client: downloader,
			config: config.torrent,
			database,
			logger,
		})
		const app = createApp({
			config,
			database,
			logger,
			manager,
			serveFrontend: false,
		})
		return new PrivateSwarmHarness(
			root,
			fixture,
			seeder,
			seedTorrent,
			database,
			config,
			downloader,
			errors,
			manager,
			app
		)
	}

	async close(): Promise<void> {
		await this.manager.close()
		this.database.close()
		await this.stopSeeder()
		await rm(this.root, { force: true, recursive: true })
	}

	async register(download = false): Promise<void> {
		const response = await this.app.request('/api/torrents', {
			body: JSON.stringify({ download, torrentId: this.magnetUri }),
			headers: { 'Content-Type': 'application/json' },
			method: 'POST',
		})
		if (response.status !== 202) {
			throw new Error(
				`Torrent registration failed with ${response.status}: ${await response.text()}`
			)
		}
		const detailsResponse = await this.app.request(
			`/api/torrents/${this.infoHash}`
		)
		if (!detailsResponse.ok) {
			throw new Error(
				`Torrent metadata failed with ${detailsResponse.status}: ${await detailsResponse.text()}; logs: ${this.errors.join(' | ')}`
			)
		}
		const details = (await detailsResponse.json()) as {
			files: Array<{ id: string; path: string[] }>
		}
		for (const fixtureFile of this.fixture.files) {
			const match = details.files.find(
				(file) => file.path.join('/') === fixtureFile.path
			)
			if (!match) {
				throw new Error(`Registered torrent omitted ${fixtureFile.path}`)
			}
			fixtureFile.id = match.id
		}
	}

	async restartWithoutSeeder(): Promise<void> {
		await this.manager.close()
		this.downloader = createClient()
		this.manager = new TorrentManager({
			client: this.downloader,
			config: this.config.torrent,
			database: this.database,
			logger: createCapturedLogger(this.errors),
		})
		this.app = createApp({
			config: this.config,
			database: this.database,
			logger: createCapturedLogger(this.errors),
			manager: this.manager,
			serveFrontend: false,
		})
	}

	async stopSeeder(): Promise<void> {
		if (this.seederStopped) {
			return
		}
		this.seederStopped = true
		await destroyClient(this.seeder)
	}

	async torrent(): Promise<Torrent> {
		const torrent = await this.downloader.get(this.infoHash)
		if (!torrent) {
			throw new Error(`Downloader has no torrent ${this.infoHash}`)
		}
		return torrent
	}

	async waitForIdleDrop(timeoutMs = DEFAULT_WAIT_TIMEOUT_MS): Promise<void> {
		await waitFor(
			() => this.manager.health().activeSessions === 0,
			'torrent idle eviction',
			timeoutMs
		)
	}
}

export const readResponse = async (
	response: Response,
	startedAt = performance.now()
): Promise<ReadMetrics> => {
	if (!response.body) {
		return {
			body: new Uint8Array(),
			durationMs: 0,
			firstByteMs: 0,
			throughputMiBPerSecond: 0,
		}
	}
	const reader = response.body.getReader()
	const first = await reader.read()
	const firstByteMs = performance.now() - startedAt
	const chunks: Uint8Array[] = []
	let totalBytes = 0
	if (!(first.done || first.value === undefined)) {
		chunks.push(first.value)
		totalBytes += first.value.byteLength
	}
	const readRemaining = async (): Promise<void> => {
		const next = await reader.read()
		if (next.done) {
			return
		}
		chunks.push(next.value)
		totalBytes += next.value.byteLength
		await readRemaining()
	}
	await readRemaining()
	const body = new Uint8Array(totalBytes)
	let offset = 0
	for (const chunk of chunks) {
		body.set(chunk, offset)
		offset += chunk.byteLength
	}
	const durationMs = performance.now() - startedAt
	return {
		body,
		durationMs,
		firstByteMs,
		throughputMiBPerSecond:
			durationMs === 0 ? 0 : totalBytes / FIXTURE_MIB / (durationMs / 1000),
	}
}

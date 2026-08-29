import { expect, test } from 'bun:test'
import {
	createAudiobookSearchService,
	DEFAULT_SEARCH_ENDPOINTS,
} from '../../server/search/service'

const LIVE_TEST_TIMEOUT_MS = 90_000
const INFO_HASH_PATTERN = /^urn:btih:[a-f\d]{40}$/i
const RAW_INFO_HASH_PATTERN = /^[a-f\d]{40}$/i
const AUDIO_FORMAT_PATTERN = /(?:MP3|M4B|Ogg|Flac)/i
const CONTENT_RANGE_PATTERN = /^bytes 0-1023\/\d+$/

interface ArchiveFile {
	format?: unknown
	name?: unknown
	size?: unknown
}

interface ArchiveMetadata {
	files?: unknown
}

const archiveFileUrl = (identifier: string, name: string): URL => {
	const encodedName = name
		.split('/')
		.map((part) => encodeURIComponent(part))
		.join('/')
	return new URL(
		`${encodeURIComponent(identifier)}/${encodedName}`,
		DEFAULT_SEARCH_ENDPOINTS.archiveDownloadBaseUrl
	)
}

const isArchiveFile = (value: unknown): value is ArchiveFile =>
	typeof value === 'object' && value !== null

test(
	'live free catalogs search, resolve a real Archive torrent, and serve audiobook bytes',
	async () => {
		const service = createAudiobookSearchService()
		const response = await service.search('Pride and Prejudice', new Set(), {
			signal: AbortSignal.timeout(60_000),
		})
		const librivoxStatus = response.providers.find(
			({ id }) => id === 'librivox'
		)
		const archiveStatus = response.providers.find(
			({ id }) => id === 'internet-archive'
		)
		expect(librivoxStatus?.state).toBe('ok')
		expect(archiveStatus?.state).toBe('ok')
		expect(archiveStatus?.count ?? 0).toBeGreaterThan(0)
		const result = response.results.find(
			({ providerId }) => providerId === 'librivox'
		)
		expect(result).toBeDefined()
		if (!result) {
			throw new Error('LibriVox returned no resolvable live result')
		}

		const magnet = new URL(
			await service.resolve(result.providerId, result.id, {
				signal: AbortSignal.timeout(45_000),
			})
		)
		expect(magnet.searchParams.get('xt')).toMatch(INFO_HASH_PATTERN)
		expect(magnet.searchParams.get('ws')).toContain(`/download/${result.id}/`)

		const metadataResponse = await fetch(
			new URL(
				`${encodeURIComponent(result.id)}?extended_err=1`,
				DEFAULT_SEARCH_ENDPOINTS.archiveMetadataBaseUrl
			),
			{ signal: AbortSignal.timeout(30_000) }
		)
		expect(metadataResponse.ok).toBe(true)
		const metadata = (await metadataResponse.json()) as ArchiveMetadata
		const files = Array.isArray(metadata.files)
			? metadata.files.filter(isArchiveFile)
			: []
		const audioFile = files.find(
			(file) =>
				typeof file.name === 'string' &&
				typeof file.format === 'string' &&
				AUDIO_FORMAT_PATTERN.test(file.format) &&
				Number(file.size) > 1024
		)
		expect(audioFile).toBeDefined()
		if (typeof audioFile?.name !== 'string') {
			throw new Error('Archive metadata returned no downloadable audio file')
		}
		const audioResponse = await fetch(
			archiveFileUrl(result.id, audioFile.name),
			{
				headers: { Range: 'bytes=0-1023' },
				signal: AbortSignal.timeout(30_000),
			}
		)
		expect(audioResponse.status).toBe(206)
		expect(audioResponse.headers.get('content-range')).toMatch(
			CONTENT_RANGE_PATTERN
		)
		expect((await audioResponse.arrayBuffer()).byteLength).toBe(1024)
	},
	LIVE_TEST_TIMEOUT_MS
)

const trackerTest =
	process.env.TPLAYER_LIVE_TRACKER_TESTS === '1' ? test : test.skip

trackerTest(
	'live optional tracker search resolves a public detail page to a valid hash without joining its swarm',
	async () => {
		const service = createAudiobookSearchService()
		const response = await service.search(
			'Alice in Wonderland',
			new Set(['audiobook-bay']),
			{ signal: AbortSignal.timeout(45_000) }
		)
		const result = response.results.find(
			({ providerId }) => providerId === 'audiobook-bay'
		)
		expect(
			response.providers.find(({ id }) => id === 'audiobook-bay')?.state
		).toBe('ok')
		expect(result).toBeDefined()
		if (!result) {
			throw new Error('AudioBookBay returned no live search result')
		}
		const infoHash = await service.resolve(result.providerId, result.id, {
			signal: AbortSignal.timeout(30_000),
		})
		expect(infoHash).toMatch(RAW_INFO_HASH_PATTERN)
	},
	LIVE_TEST_TIMEOUT_MS
)

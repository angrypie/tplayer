import { type Server, serve } from 'bun'
import type { AudiobookSearchEndpoints } from '../types'

const ARCHIVE_ID = 'private_swarm_librivox'
const ARCHIVE_SECOND_ID = 'private_swarm_archive_edition'
const TRACKER_SLUG = 'private-swarm-audiobook-test-edition'
const TINY_PNG = Uint8Array.from([
	137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0,
	0, 0, 1, 8, 4, 0, 0, 0, 181, 28, 12, 2, 0, 0, 0, 11, 73, 68, 65, 84, 120, 218,
	99, 252, 255, 31, 0, 3, 3, 2, 0, 238, 254, 239, 93, 0, 0, 0, 0, 73, 69, 78,
	68, 174, 66, 96, 130,
])

export interface SearchUpstreamMetrics {
	archiveMetadataRequests: number
	audiobookBayDetailRequests: number
	audiobookBaySearchRequests: number
	internetArchiveSearchRequests: number
	librivoxSearchRequests: number
}

const emptyMetrics = (): SearchUpstreamMetrics => ({
	archiveMetadataRequests: 0,
	audiobookBayDetailRequests: 0,
	audiobookBaySearchRequests: 0,
	internetArchiveSearchRequests: 0,
	librivoxSearchRequests: 0,
})

const invalidRequest = (message: string): Response =>
	Response.json({ error: message }, { status: 400 })

export class SearchUpstreamHarness {
	readonly endpoints: AudiobookSearchEndpoints
	private readonly infoHash: string
	private readonly metrics: SearchUpstreamMetrics
	private readonly name: string
	private readonly server: Server<undefined>

	private constructor(
		server: Server<undefined>,
		infoHash: string,
		name: string,
		metrics: SearchUpstreamMetrics
	) {
		this.server = server
		this.infoHash = infoHash
		this.name = name
		this.metrics = metrics
		const root = server.url.toString()
		this.endpoints = {
			archiveDetailsBaseUrl: `${root}archive/details/`,
			archiveDownloadBaseUrl: `${root}archive/download/`,
			archiveImageBaseUrl: `${root}archive/image/`,
			archiveMetadataBaseUrl: `${root}archive/metadata/`,
			audiobookBayBaseUrl: `${root}abb/`,
			internetArchiveSearchUrl: `${root}archive/advancedsearch.php`,
			librivoxApiUrl: `${root}librivox/api/feed/audiobooks/`,
		}
	}

	static start(infoHash: string, name: string): SearchUpstreamHarness {
		const metrics = emptyMetrics()
		let harness: SearchUpstreamHarness | undefined
		const server = serve({
			fetch: (request) => {
				if (!harness) {
					return new Response('Fixture is starting', { status: 503 })
				}
				return harness.respond(request)
			},
			hostname: '127.0.0.1',
			port: 0,
		})
		harness = new SearchUpstreamHarness(server, infoHash, name, metrics)
		return harness
	}

	close(): void {
		this.server.stop(true)
	}

	snapshot(): SearchUpstreamMetrics {
		return { ...this.metrics }
	}

	private archiveMetadata(identifier: string): Response {
		this.metrics.archiveMetadataRequests += 1
		if (![ARCHIVE_ID, ARCHIVE_SECOND_ID].includes(identifier)) {
			return Response.json({ error: 'not found' }, { status: 404 })
		}
		return Response.json({
			files: [
				{
					btih: this.infoHash,
					format: 'Archive BitTorrent',
					name: `${identifier}_archive.torrent`,
				},
			],
			metadata: { identifier, title: this.name },
		})
	}

	private audiobookBayFeed(url: URL): Response {
		this.metrics.audiobookBaySearchRequests += 1
		const searchTerm = url.searchParams.get('s') ?? ''
		if (
			url.searchParams.get('feed') !== 'rss2' ||
			!searchTerm ||
			searchTerm !== searchTerm.toLocaleLowerCase()
		) {
			return invalidRequest('AudioBookBay query contract was not satisfied')
		}
		const { origin } = url
		const link = `${origin}/abb/abss/${TRACKER_SLUG}/`
		return new Response(
			`<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/"><channel>
<item><title>${this.name} - Test Author</title><link>${link}</link>
<pubDate>Fri, 28 Aug 2026 10:00:00 +0000</pubDate>
<category><![CDATA[English]]></category>
<description><![CDATA[Written by Test Author Read by Test Narrator Format: M4B Unabridged. A tracker fixture that resolves through the real torrent manager.]]></description>
<media:thumbnail url="${origin}/cover.png" /></item>
</channel></rss>`,
			{ headers: { 'Content-Type': 'application/rss+xml' } }
		)
	}

	private internetArchiveSearch(url: URL): Response {
		this.metrics.internetArchiveSearchRequests += 1
		const query = url.searchParams.get('q') ?? ''
		const fields = url.searchParams.getAll('fl[]')
		if (
			!(
				query.includes('mediatype:audio') &&
				query.includes('format:"Archive BitTorrent"') &&
				query.includes('licenseurl:*')
			) ||
			url.searchParams.get('output') !== 'json' ||
			url.searchParams.get('rows') !== '24' ||
			!fields.includes('identifier') ||
			!fields.includes('title')
		) {
			return invalidRequest('Internet Archive query contract was not satisfied')
		}
		if (query.includes('archive outage')) {
			return Response.json({ error: 'planned outage' }, { status: 503 })
		}
		return Response.json({
			response: {
				docs: [
					{
						creator: 'Test Author',
						description:
							'The duplicate Archive record for the LibriVox fixture.',
						downloads: 1200,
						identifier: ARCHIVE_ID,
						language: 'English',
						licenseurl: 'https://creativecommons.org/publicdomain/zero/1.0/',
						publicdate: '2026-08-28T10:00:00Z',
						title: this.name,
					},
					{
						creator: ['Test Author', 'Test Reader'],
						description: 'A second freely licensed Archive audiobook edition.',
						downloads: 900,
						identifier: ARCHIVE_SECOND_ID,
						item_size: 12_582_912,
						language: ['English'],
						licenseurl: 'https://creativecommons.org/licenses/by/4.0/',
						title: `${this.name} — Archive edition`,
					},
				],
				numFound: 2,
				start: 0,
			},
		})
	}

	private librivoxSearch(url: URL): Response {
		this.metrics.librivoxSearchRequests += 1
		const fields = url.searchParams.getAll('fields[]')
		if (
			!(url.searchParams.has('title') || url.searchParams.has('author')) ||
			url.searchParams.get('format') !== 'json' ||
			url.searchParams.get('extended') !== '1' ||
			url.searchParams.get('coverart') !== '1' ||
			!fields.includes('url_iarchive') ||
			!fields.includes('authors')
		) {
			return invalidRequest('LibriVox query contract was not satisfied')
		}
		const { origin } = url
		return Response.json({
			books: [
				{
					authors: [{ first_name: 'Test', id: '1', last_name: 'Author' }],
					coverart_thumbnail: `${origin}/cover.png`,
					description:
						'<p>A <strong>public-domain</strong> fixture from LibriVox.</p>',
					id: '1',
					language: 'English',
					title: this.name,
					totaltimesecs: 42,
					url_iarchive: `https://archive.org/details/${ARCHIVE_ID}`,
					url_librivox: 'https://librivox.org/test-audiobook/',
				},
			],
		})
	}

	private respond(request: Request): Response {
		const url = new URL(request.url)
		if (url.pathname === '/librivox/api/feed/audiobooks/') {
			return this.librivoxSearch(url)
		}
		if (url.pathname === '/archive/advancedsearch.php') {
			return this.internetArchiveSearch(url)
		}
		if (url.pathname.startsWith('/archive/metadata/')) {
			return this.archiveMetadata(url.pathname.split('/').at(-1) ?? '')
		}
		if (url.pathname === '/abb/' && url.searchParams.has('feed')) {
			return this.audiobookBayFeed(url)
		}
		if (url.pathname === `/abb/abss/${TRACKER_SLUG}/`) {
			this.metrics.audiobookBayDetailRequests += 1
			return new Response(
				`<html><body><h1>${this.name}</h1><table><tr><td>Info Hash:</td><td>${this.infoHash}</td></tr></table></body></html>`,
				{ headers: { 'Content-Type': 'text/html' } }
			)
		}
		if (url.pathname === '/cover.png') {
			return new Response(TINY_PNG, {
				headers: { 'Content-Type': 'image/png' },
			})
		}
		return new Response('Not found', { status: 404 })
	}
}

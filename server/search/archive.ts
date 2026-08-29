import { HttpError } from '../errors'
import {
	ProviderRequestError,
	parseJsonResponse,
	requestProviderText,
} from './http'
import { isRecord, readString, validArchiveIdentifier } from './parsing'
import type {
	AudiobookSearchEndpoints,
	AudiobookSearchOptions,
	SearchFetcher,
} from './types'

const INFO_HASH_PATTERN = /^[a-f\d]{40}$/i
const ARCHIVE_TRACKERS = [
	'http://bt1.archive.org:6969/announce',
	'http://bt2.archive.org:6969/announce',
] as const

export class ArchiveTorrentResolver {
	private readonly endpoints: AudiobookSearchEndpoints
	private readonly fetcher: SearchFetcher

	constructor(fetcher: SearchFetcher, endpoints: AudiobookSearchEndpoints) {
		this.fetcher = fetcher
		this.endpoints = endpoints
	}

	async resolve(
		identifier: string,
		options: AudiobookSearchOptions = {}
	): Promise<string> {
		if (!validArchiveIdentifier(identifier)) {
			throw new HttpError(
				422,
				'invalid_search_result',
				'Archive audiobook identifier is invalid'
			)
		}
		const url = new URL(
			`${encodeURIComponent(identifier)}?extended_err=1`,
			this.withTrailingSlash(this.endpoints.archiveMetadataBaseUrl)
		)
		const { response, text } = await requestProviderText(this.fetcher, url, {
			accept: 'application/json',
			label: 'Internet Archive metadata',
			maxBytes: 4 * 1024 * 1024,
			signal: options.signal,
		})
		if (response.status === 404) {
			throw new HttpError(
				404,
				'search_result_not_found',
				'Internet Archive audiobook was not found'
			)
		}
		if (!response.ok) {
			throw new ProviderRequestError(
				`Internet Archive metadata returned HTTP ${response.status}`
			)
		}
		const value = parseJsonResponse(text, 'Internet Archive metadata')
		if (!isRecord(value)) {
			throw new ProviderRequestError(
				'Internet Archive metadata response was invalid'
			)
		}
		const files = Array.isArray(value.files) ? value.files : []
		const torrent = files.find(
			(file) =>
				isRecord(file) && readString(file, 'format') === 'Archive BitTorrent'
		)
		const infoHash = isRecord(torrent) ? readString(torrent, 'btih') : undefined
		if (!(infoHash && INFO_HASH_PATTERN.test(infoHash))) {
			throw new ProviderRequestError(
				'Internet Archive item has no usable torrent hash'
			)
		}
		const metadata = isRecord(value.metadata) ? value.metadata : {}
		const title = readString(metadata, 'title') ?? identifier
		return this.buildMagnet(infoHash.toLowerCase(), title, identifier)
	}

	private buildMagnet(
		infoHash: string,
		title: string,
		identifier: string
	): string {
		const parameters = new URLSearchParams({
			dn: title,
			ws: new URL(
				`${encodeURIComponent(identifier)}/`,
				this.withTrailingSlash(this.endpoints.archiveDownloadBaseUrl)
			).toString(),
		})
		for (const tracker of ARCHIVE_TRACKERS) {
			parameters.append('tr', tracker)
		}
		return `magnet:?xt=urn:btih:${infoHash}&${parameters.toString()}`
	}

	private withTrailingSlash(value: string): string {
		return value.endsWith('/') ? value : `${value}/`
	}
}

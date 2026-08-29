import type { ArchiveTorrentResolver } from '../archive'
import {
	ProviderRequestError,
	parseJsonResponse,
	requestProviderText,
} from '../http'
import {
	isRecord,
	plainText,
	readFiniteNumber,
	readString,
	readStringList,
	safeHttpUrl,
	validArchiveIdentifier,
} from '../parsing'
import type {
	AudiobookProvider,
	AudiobookSearchEndpoints,
	AudiobookSearchOptions,
	AudiobookSearchResult,
	SearchFetcher,
} from '../types'

const ARCHIVE_FIELDS = [
	'identifier',
	'title',
	'creator',
	'description',
	'date',
	'publicdate',
	'language',
	'licenseurl',
	'downloads',
	'item_size',
	'subject',
] as const

const escapeLucenePhrase = (value: string): string =>
	value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')

const readDocuments = (value: unknown): Record<string, unknown>[] => {
	if (!(isRecord(value) && isRecord(value.response))) {
		throw new ProviderRequestError(
			'Internet Archive search response had an invalid shape'
		)
	}
	const documents = value.response.docs
	if (!Array.isArray(documents)) {
		throw new ProviderRequestError(
			'Internet Archive search response did not include results'
		)
	}
	return documents.filter(isRecord)
}

const firstString = (value: unknown): string | undefined =>
	readStringList(value).at(0)

export class InternetArchiveProvider implements AudiobookProvider {
	readonly descriptor = {
		defaultEnabled: true,
		homepage: 'https://archive.org',
		id: 'internet-archive',
		kind: 'free',
		label: 'Internet Archive',
	} as const

	private readonly archiveResolver: ArchiveTorrentResolver
	private readonly endpoints: AudiobookSearchEndpoints
	private readonly fetcher: SearchFetcher

	constructor(
		fetcher: SearchFetcher,
		endpoints: AudiobookSearchEndpoints,
		archiveResolver: ArchiveTorrentResolver
	) {
		this.fetcher = fetcher
		this.endpoints = endpoints
		this.archiveResolver = archiveResolver
	}

	async resolve(
		resultId: string,
		options?: AudiobookSearchOptions
	): Promise<string> {
		return await this.archiveResolver.resolve(resultId, options)
	}

	async search(
		query: string,
		options: AudiobookSearchOptions = {}
	): Promise<AudiobookSearchResult[]> {
		const phrase = escapeLucenePhrase(query)
		const catalogFilter = [
			'mediatype:audio',
			'format:"Archive BitTorrent"',
			'(collection:librivoxaudio OR ((subject:audiobook OR subject:audiobooks OR subject:"audio book" OR subject:"audio books") AND licenseurl:*))',
			`(title:"${phrase}" OR creator:"${phrase}" OR description:"${phrase}")`,
		].join(' AND ')
		const url = new URL(this.endpoints.internetArchiveSearchUrl)
		url.searchParams.set('q', catalogFilter)
		for (const field of ARCHIVE_FIELDS) {
			url.searchParams.append('fl[]', field)
		}
		url.searchParams.set('rows', '24')
		url.searchParams.set('page', '1')
		url.searchParams.set('output', 'json')
		url.searchParams.append('sort[]', 'downloads desc')
		const { response, text } = await requestProviderText(this.fetcher, url, {
			accept: 'application/json',
			label: 'Internet Archive search',
			signal: options.signal,
		})
		if (!response.ok) {
			throw new ProviderRequestError(
				`Internet Archive search returned HTTP ${response.status}`
			)
		}
		const documents = readDocuments(
			parseJsonResponse(text, 'Internet Archive search')
		)
		return documents
			.map((document) => this.toResult(document))
			.filter((result): result is AudiobookSearchResult => result !== null)
	}

	private toResult(
		document: Record<string, unknown>
	): AudiobookSearchResult | null {
		const identifier = readString(document, 'identifier')?.trim() ?? ''
		const title = firstString(document.title)?.trim()
		if (!(validArchiveIdentifier(identifier) && title)) {
			return null
		}
		const coverUrl = safeHttpUrl(
			new URL(
				encodeURIComponent(identifier),
				this.withTrailingSlash(this.endpoints.archiveImageBaseUrl)
			).toString()
		)
		const detailUrl = safeHttpUrl(
			new URL(
				encodeURIComponent(identifier),
				this.withTrailingSlash(this.endpoints.archiveDetailsBaseUrl)
			).toString()
		)
		const description = plainText(firstString(document.description) ?? '')
		const downloads = readFiniteNumber(document, 'downloads')
		const sizeBytes = readFiniteNumber(document, 'item_size')
		const language = firstString(document.language)
		const publishedAt = firstString(document.publicdate ?? document.date)
		return {
			authors: readStringList(document.creator),
			id: identifier,
			providerId: this.descriptor.id,
			title,
			...(coverUrl ? { coverUrl } : {}),
			...(description ? { description } : {}),
			...(detailUrl ? { detailUrl } : {}),
			...(downloads === undefined ? {} : { downloads }),
			...(language ? { language } : {}),
			...(publishedAt ? { publishedAt } : {}),
			...(sizeBytes === undefined ? {} : { sizeBytes }),
		}
	}

	private withTrailingSlash(value: string): string {
		return value.endsWith('/') ? value : `${value}/`
	}
}

import { HttpError } from '../../errors'
import { ProviderRequestError, requestProviderText } from '../http'
import { decodeEntities, plainText, safeHttpUrl } from '../parsing'
import type {
	AudiobookProvider,
	AudiobookSearchEndpoints,
	AudiobookSearchOptions,
	AudiobookSearchResult,
	SearchFetcher,
} from '../types'

const TITLE_PATTERN = /<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i
const LINK_PATTERN = /<link>([\s\S]*?)<\/link>/i
const DESCRIPTION_PATTERN =
	/<description>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/i
const PUBLISHED_PATTERN = /<pubDate>([\s\S]*?)<\/pubDate>/i
const THUMBNAIL_PATTERN = /<media:thumbnail[^>]+url=["']([^"']+)["']/i
const CATEGORY_PATTERN =
	/<category>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/category>/gi
const WRITTEN_BY_PATTERN = /\bWritten by\s+(.+?)\s+Read by\b/i
const FORMAT_PATTERN = /\bFormat:\s*([a-z\d]+)/i
const INFO_HASH_PATTERN = /\bInfo\s*Hash:[\s\S]{0,500}?([a-f\d]{40})\b/i
const DETAIL_PATH_PATTERN = /\/abss\/([a-z\d-]{1,180})\/?$/i
const RESULT_ID_PATTERN = /^[a-z\d-]{1,180}$/i
const RSS_DOCUMENT_PATTERN = /<rss\b[\s\S]*?<channel\b/i
const COMMON_LANGUAGES = new Set([
	'Chinese',
	'Dutch',
	'English',
	'French',
	'German',
	'Italian',
	'Japanese',
	'Portuguese',
	'Russian',
	'Spanish',
])

const elementText = (item: string, pattern: RegExp): string | undefined => {
	const value = item.match(pattern)?.[1]
	return value ? decodeEntities(value).trim() : undefined
}

const resultSlug = (link: string | undefined): string | undefined => {
	if (!(link && URL.canParse(link))) {
		return undefined
	}
	return new URL(link).pathname.match(DETAIL_PATH_PATTERN)?.[1]
}

const publishedDate = (value: string | undefined): string | undefined => {
	if (!value) {
		return undefined
	}
	const date = new Date(value)
	return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}

export class AudiobookBayProvider implements AudiobookProvider {
	readonly descriptor = {
		defaultEnabled: false,
		homepage: 'https://audiobookbay.lu',
		id: 'audiobook-bay',
		kind: 'tracker',
		label: 'AudioBookBay',
	} as const

	private readonly endpoints: AudiobookSearchEndpoints
	private readonly fetcher: SearchFetcher

	constructor(fetcher: SearchFetcher, endpoints: AudiobookSearchEndpoints) {
		this.fetcher = fetcher
		this.endpoints = endpoints
	}

	async resolve(
		resultId: string,
		options: AudiobookSearchOptions = {}
	): Promise<string> {
		if (!RESULT_ID_PATTERN.test(resultId)) {
			throw new HttpError(
				422,
				'invalid_search_result',
				'AudioBookBay result identifier is invalid'
			)
		}
		const url = new URL(
			`abss/${encodeURIComponent(resultId)}/`,
			this.withTrailingSlash(this.endpoints.audiobookBayBaseUrl)
		)
		const { response, text } = await requestProviderText(this.fetcher, url, {
			accept: 'text/html,application/xhtml+xml',
			label: 'AudioBookBay details',
			maxBytes: 3 * 1024 * 1024,
			signal: options.signal,
		})
		if (response.status === 404) {
			throw new HttpError(
				404,
				'search_result_not_found',
				'AudioBookBay audiobook was not found'
			)
		}
		if (!response.ok) {
			throw new ProviderRequestError(
				`AudioBookBay details returned HTTP ${response.status}`
			)
		}
		const infoHash = text.match(INFO_HASH_PATTERN)?.[1]?.toLowerCase()
		if (!infoHash) {
			throw new ProviderRequestError(
				'AudioBookBay details contained no usable torrent hash'
			)
		}
		return infoHash
	}

	async search(
		query: string,
		options: AudiobookSearchOptions = {}
	): Promise<AudiobookSearchResult[]> {
		const url = new URL(this.endpoints.audiobookBayBaseUrl)
		// AudioBookBay redirects searches encoded with `+` back to its home page.
		// It also rejects capitalized terms, so use its lowercase `%20` form.
		const searchTerm = query.slice(0, 50).toLocaleLowerCase()
		url.search = `?s=${encodeURIComponent(searchTerm)}&feed=rss2`
		const { response, text } = await requestProviderText(this.fetcher, url, {
			accept: 'application/rss+xml,application/xml,text/xml',
			label: 'AudioBookBay search',
			maxBytes: 3 * 1024 * 1024,
			signal: options.signal,
		})
		if (!response.ok) {
			throw new ProviderRequestError(
				`AudioBookBay search returned HTTP ${response.status}`
			)
		}
		if (!RSS_DOCUMENT_PATTERN.test(text)) {
			throw new ProviderRequestError(
				'AudioBookBay search returned an invalid RSS feed'
			)
		}
		const results: AudiobookSearchResult[] = []
		for (const remainder of text.split('<item>').slice(1)) {
			const item = remainder.split('</item>', 1)[0] ?? ''
			const result = this.toResult(item)
			if (result) {
				results.push(result)
			}
		}
		return results
	}

	private toResult(item: string): AudiobookSearchResult | null {
		const title = plainText(elementText(item, TITLE_PATTERN) ?? '', 240)
		const link = safeHttpUrl(elementText(item, LINK_PATTERN))
		const id = resultSlug(link)
		if (!(id && title)) {
			return null
		}
		const rawDescription = elementText(item, DESCRIPTION_PATTERN) ?? ''
		const cleanDescription = plainText(rawDescription)
		const writtenBy = cleanDescription.match(WRITTEN_BY_PATTERN)?.[1]
		const authors = writtenBy
			? writtenBy
					.split(',')
					.map((author) => author.trim())
					.filter(Boolean)
			: []
		const categories = [...item.matchAll(CATEGORY_PATTERN)].map((match) =>
			plainText(match[1] ?? '')
		)
		const language = categories.find((category) =>
			COMMON_LANGUAGES.has(category)
		)
		const coverUrl = safeHttpUrl(
			decodeEntities(item.match(THUMBNAIL_PATTERN)?.[1] ?? '')
		)
		const format = cleanDescription.match(FORMAT_PATTERN)?.[1]?.toUpperCase()
		const publishedAt = publishedDate(elementText(item, PUBLISHED_PATTERN))
		return {
			authors,
			id,
			providerId: this.descriptor.id,
			title,
			...(coverUrl ? { coverUrl } : {}),
			...(cleanDescription ? { description: cleanDescription } : {}),
			...(link ? { detailUrl: link } : {}),
			...(format ? { format } : {}),
			...(language ? { language } : {}),
			...(publishedAt ? { publishedAt } : {}),
		}
	}

	private withTrailingSlash(value: string): string {
		return value.endsWith('/') ? value : `${value}/`
	}
}

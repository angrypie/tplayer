import type { ArchiveTorrentResolver } from '../archive'
import {
	ProviderRequestError,
	parseJsonResponse,
	requestProviderText,
} from '../http'
import {
	archiveIdentifierFromUrl,
	isRecord,
	plainText,
	readFiniteNumber,
	readString,
	safeHttpUrl,
} from '../parsing'
import type {
	AudiobookProvider,
	AudiobookSearchEndpoints,
	AudiobookSearchOptions,
	AudiobookSearchResult,
	SearchFetcher,
} from '../types'

const LIBRIVOX_FIELDS = [
	'id',
	'title',
	'description',
	'language',
	'copyright_year',
	'url_librivox',
	'url_iarchive',
	'totaltimesecs',
	'authors',
	'coverart_thumbnail',
] as const
const QUERY_TERM_SEPARATOR_PATTERN = /\s+/
const NO_AUDIOBOOKS_PATTERN = /no audiobooks? found/i

const authorName = (value: unknown): string | undefined => {
	if (!isRecord(value)) {
		return undefined
	}
	const name = [readString(value, 'first_name'), readString(value, 'last_name')]
		.filter(Boolean)
		.join(' ')
		.trim()
	return name || undefined
}

const readBooks = (value: unknown): Record<string, unknown>[] => {
	if (!isRecord(value)) {
		throw new ProviderRequestError('LibriVox response had an invalid shape')
	}
	if (
		typeof value.error === 'string' &&
		NO_AUDIOBOOKS_PATTERN.test(value.error)
	) {
		return []
	}
	if (!Array.isArray(value.books)) {
		throw new ProviderRequestError('LibriVox response did not include books')
	}
	return value.books.filter(isRecord)
}

export class LibrivoxProvider implements AudiobookProvider {
	readonly descriptor = {
		defaultEnabled: true,
		homepage: 'https://librivox.org',
		id: 'librivox',
		kind: 'free',
		label: 'LibriVox',
		rights: 'public-domain-source',
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
		const lastTerm =
			query.trim().split(QUERY_TERM_SEPARATOR_PATTERN).at(-1) ?? query
		const requests = await Promise.allSettled([
			this.searchField('title', `^${query}`, options),
			this.searchField('author', lastTerm, options),
		])
		const books: Record<string, unknown>[] = []
		let firstFailure: unknown
		for (const request of requests) {
			if (request.status === 'fulfilled') {
				books.push(...request.value)
			} else {
				firstFailure ??= request.reason
			}
		}
		if (
			books.length === 0 &&
			requests.every(({ status }) => status === 'rejected')
		) {
			throw firstFailure
		}
		const results = new Map<string, AudiobookSearchResult>()
		for (const book of books) {
			const result = this.toResult(book)
			if (result && !results.has(result.id)) {
				results.set(result.id, result)
			}
		}
		return [...results.values()]
	}

	private async searchField(
		field: 'author' | 'title',
		value: string,
		options: AudiobookSearchOptions
	): Promise<Record<string, unknown>[]> {
		const url = new URL(this.endpoints.librivoxApiUrl)
		url.searchParams.set(field, value)
		url.searchParams.set('format', 'json')
		url.searchParams.set('extended', '1')
		url.searchParams.set('coverart', '1')
		url.searchParams.set('limit', '16')
		for (const selectedField of LIBRIVOX_FIELDS) {
			url.searchParams.append('fields[]', selectedField)
		}
		const { response, text } = await requestProviderText(this.fetcher, url, {
			accept: 'application/json',
			label: 'LibriVox',
			signal: options.signal,
			timeoutMs: 45_000,
		})
		if (response.status === 404) {
			return []
		}
		if (!response.ok) {
			throw new ProviderRequestError(
				`LibriVox returned HTTP ${response.status}`
			)
		}
		return readBooks(parseJsonResponse(text, 'LibriVox'))
	}

	private toResult(
		book: Record<string, unknown>
	): AudiobookSearchResult | null {
		const identifier = archiveIdentifierFromUrl(
			readString(book, 'url_iarchive')
		)
		const title = readString(book, 'title')?.trim()
		if (!(identifier && title)) {
			return null
		}
		const authors = Array.isArray(book.authors)
			? book.authors
					.map(authorName)
					.filter((name): name is string => name !== undefined)
			: []
		const description = plainText(readString(book, 'description') ?? '')
		const durationSeconds = readFiniteNumber(book, 'totaltimesecs')
		const coverUrl = safeHttpUrl(readString(book, 'coverart_thumbnail'))
		const detailUrl = safeHttpUrl(readString(book, 'url_librivox'))
		const language = readString(book, 'language')?.trim()
		return {
			authors,
			id: identifier,
			providerId: this.descriptor.id,
			title,
			...(coverUrl ? { coverUrl } : {}),
			...(description ? { description } : {}),
			...(detailUrl ? { detailUrl } : {}),
			...(durationSeconds === undefined ? {} : { durationSeconds }),
			...(language ? { language } : {}),
		}
	}
}

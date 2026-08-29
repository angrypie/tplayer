import { HttpError } from '../errors'
import { ArchiveTorrentResolver } from './archive'
import { AudiobookBayProvider } from './providers/audiobookBay'
import { InternetArchiveProvider } from './providers/internetArchive'
import { LibrivoxProvider } from './providers/librivox'
import type {
	AudiobookProvider,
	AudiobookProviderDescriptor,
	AudiobookProviderId,
	AudiobookSearchEndpoints,
	AudiobookSearchOptions,
	AudiobookSearchResponse,
	AudiobookSearchResult,
	SearchFetcher,
} from './types'

const SEARCH_CACHE_TTL_MS = 5 * 60 * 1000
const RESOLUTION_CACHE_TTL_MS = 60 * 60 * 1000
const MAXIMUM_CACHE_ENTRIES = 200

export const DEFAULT_SEARCH_ENDPOINTS: AudiobookSearchEndpoints = {
	archiveDetailsBaseUrl: 'https://archive.org/details/',
	archiveDownloadBaseUrl: 'https://archive.org/download/',
	archiveImageBaseUrl: 'https://archive.org/services/img/',
	archiveMetadataBaseUrl: 'https://archive.org/metadata/',
	audiobookBayBaseUrl: 'https://audiobookbay.lu/',
	internetArchiveSearchUrl: 'https://archive.org/advancedsearch.php',
	librivoxApiUrl: 'https://librivox.org/api/feed/audiobooks/',
}

interface CacheEntry<Value> {
	expiresAt: number
	value: Value
}

export interface AudiobookSearchServiceOptions {
	endpoints?: AudiobookSearchEndpoints
	fetcher?: SearchFetcher
	providers?: readonly AudiobookProvider[]
}

const normalizedQuery = (query: string): string =>
	query.trim().replaceAll(/\s+/g, ' ').toLocaleLowerCase()

const errorMessage = (descriptor: AudiobookProviderDescriptor): string =>
	`${descriptor.label} is temporarily unavailable`

export const assertSearchRequestActive = (signal?: AbortSignal): void => {
	if (signal?.aborted) {
		throw new HttpError(499, 'request_cancelled', 'Search was cancelled')
	}
}

const pruneCache = <Value>(cache: Map<string, CacheEntry<Value>>): void => {
	const now = Date.now()
	for (const [key, entry] of cache) {
		if (entry.expiresAt <= now) {
			cache.delete(key)
		}
	}
	while (cache.size > MAXIMUM_CACHE_ENTRIES) {
		const oldestKey = cache.keys().next().value
		if (typeof oldestKey !== 'string') {
			break
		}
		cache.delete(oldestKey)
	}
}

export class AudiobookSearchService {
	private readonly providers: readonly AudiobookProvider[]
	private readonly providersById: ReadonlyMap<
		AudiobookProviderId,
		AudiobookProvider
	>
	private readonly resolutionCache = new Map<string, CacheEntry<string>>()
	private readonly searchCache = new Map<
		string,
		CacheEntry<readonly AudiobookSearchResult[]>
	>()

	constructor(providers: readonly AudiobookProvider[]) {
		this.providers = providers
		this.providersById = new Map(
			providers.map((provider) => [provider.descriptor.id, provider])
		)
	}

	descriptors(): AudiobookProviderDescriptor[] {
		return this.providers.map(({ descriptor }) => ({ ...descriptor }))
	}

	async resolve(
		providerId: AudiobookProviderId,
		resultId: string,
		options: AudiobookSearchOptions = {}
	): Promise<string> {
		assertSearchRequestActive(options.signal)
		const provider = this.providersById.get(providerId)
		if (!provider) {
			throw new HttpError(
				422,
				'unknown_search_provider',
				'Search provider is not available'
			)
		}
		const key = `${providerId}\0${resultId}`
		const cached = this.resolutionCache.get(key)
		if (cached && cached.expiresAt > Date.now()) {
			return cached.value
		}
		try {
			const reference = await provider.resolve(resultId, options)
			assertSearchRequestActive(options.signal)
			this.resolutionCache.set(key, {
				expiresAt: Date.now() + RESOLUTION_CACHE_TTL_MS,
				value: reference,
			})
			pruneCache(this.resolutionCache)
			return reference
		} catch (value) {
			if (value instanceof HttpError) {
				throw value
			}
			assertSearchRequestActive(options.signal)
			// biome-ignore lint/style/useErrorCause: HttpError forwards cause through its options argument.
			throw new HttpError(
				502,
				'search_provider_unavailable',
				`${provider.descriptor.label} could not resolve this audiobook`,
				{},
				{ cause: value }
			)
		}
	}

	async search(
		query: string,
		optionalProviderIds: ReadonlySet<AudiobookProviderId>,
		options: AudiobookSearchOptions = {}
	): Promise<AudiobookSearchResponse> {
		assertSearchRequestActive(options.signal)
		const selected = this.providers.filter(
			(provider) =>
				provider.descriptor.defaultEnabled ||
				optionalProviderIds.has(provider.descriptor.id)
		)
		const settled = await Promise.allSettled(
			selected.map(async (provider) => ({
				provider,
				results: await this.searchProvider(provider, query, options),
			}))
		)
		assertSearchRequestActive(options.signal)
		const results: AudiobookSearchResult[] = []
		const providers = settled.map((entry, index) => {
			const provider = selected[index]
			if (!provider) {
				throw new Error('Search provider registry changed during a request')
			}
			if (entry.status === 'rejected') {
				return {
					count: 0,
					error: errorMessage(provider.descriptor),
					id: provider.descriptor.id,
					label: provider.descriptor.label,
					state: 'error' as const,
				}
			}
			results.push(...entry.value.results)
			return {
				count: entry.value.results.length,
				id: provider.descriptor.id,
				label: provider.descriptor.label,
				state: 'ok' as const,
			}
		})
		return {
			providers,
			query: query.trim(),
			results: this.deduplicateFreeResults(results),
		}
	}

	private deduplicateFreeResults(
		results: AudiobookSearchResult[]
	): AudiobookSearchResult[] {
		const seenFreeResults = new Set<string>()
		return results.filter((result) => {
			const provider = this.providersById.get(result.providerId)
			if (provider?.descriptor.kind !== 'free') {
				return true
			}
			if (seenFreeResults.has(result.id)) {
				return false
			}
			seenFreeResults.add(result.id)
			return true
		})
	}

	private async searchProvider(
		provider: AudiobookProvider,
		query: string,
		options: AudiobookSearchOptions
	): Promise<readonly AudiobookSearchResult[]> {
		const key = `${provider.descriptor.id}\0${normalizedQuery(query)}`
		const cached = this.searchCache.get(key)
		if (cached && cached.expiresAt > Date.now()) {
			return cached.value
		}
		const results = await provider.search(query, options)
		assertSearchRequestActive(options.signal)
		this.searchCache.set(key, {
			expiresAt: Date.now() + SEARCH_CACHE_TTL_MS,
			value: results,
		})
		pruneCache(this.searchCache)
		return results
	}
}

export const createAudiobookSearchService = ({
	endpoints = DEFAULT_SEARCH_ENDPOINTS,
	fetcher = globalThis.fetch,
	providers,
}: AudiobookSearchServiceOptions = {}): AudiobookSearchService => {
	if (providers) {
		return new AudiobookSearchService(providers)
	}
	const archiveResolver = new ArchiveTorrentResolver(fetcher, endpoints)
	return new AudiobookSearchService([
		new LibrivoxProvider(fetcher, endpoints, archiveResolver),
		new InternetArchiveProvider(fetcher, endpoints, archiveResolver),
		new AudiobookBayProvider(fetcher, endpoints),
	])
}

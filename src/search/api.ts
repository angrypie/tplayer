import type {
	AudiobookSearchResponse,
	AudiobookSearchResult,
	ResolvedTorrentRegistration,
	SearchProviderCatalog,
	SearchProviderDescriptor,
	SearchProviderKind,
	SearchProviderReport,
	SearchProviderRights,
	SearchProviderState,
} from './types'

const API_ROOT = '/api/search'

type Fetcher = (
	...arguments_: Parameters<typeof fetch>
) => ReturnType<typeof fetch>

const defaultFetcher: Fetcher = (...arguments_) => fetch(...arguments_)

export interface SearchApiClientOptions {
	fetcher?: Fetcher
}

export class SearchApiError extends Error {
	readonly code: string
	readonly status: number

	constructor(status: number, code: string, message: string) {
		super(message)
		this.name = 'SearchApiError'
		this.code = code
		this.status = status
	}
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value)

const invalidResponse = (message: string): SearchApiError =>
	new SearchApiError(502, 'invalid_response', message)

const requiredString = (
	value: Record<string, unknown>,
	key: string,
	context: string
): string => {
	const candidate = value[key]
	if (typeof candidate !== 'string' || candidate.trim().length === 0) {
		throw invalidResponse(`${context} did not include ${key}`)
	}
	return candidate
}

const optionalString = (
	value: Record<string, unknown>,
	key: string,
	context: string
): string | undefined => {
	const candidate = value[key]
	if (candidate === undefined || candidate === null) {
		return undefined
	}
	if (typeof candidate !== 'string') {
		throw invalidResponse(`${context} included an invalid ${key}`)
	}
	return candidate || undefined
}

const optionalNumber = (
	value: Record<string, unknown>,
	key: string,
	context: string
): number | undefined => {
	const candidate = value[key]
	if (candidate === undefined || candidate === null) {
		return undefined
	}
	if (
		typeof candidate !== 'number' ||
		!Number.isFinite(candidate) ||
		candidate < 0
	) {
		throw invalidResponse(`${context} included an invalid ${key}`)
	}
	return candidate
}

const stringArray = (
	value: Record<string, unknown>,
	key: string,
	context: string
): string[] => {
	const candidate = value[key]
	if (
		!Array.isArray(candidate) ||
		candidate.some((entry) => typeof entry !== 'string')
	) {
		throw invalidResponse(`${context} included invalid ${key}`)
	}
	return candidate.map((entry) => entry.trim()).filter(Boolean)
}

const providerKind = (value: unknown): SearchProviderKind => {
	if (value === 'free' || value === 'tracker') {
		return value
	}
	throw invalidResponse('Search provider included an invalid kind')
}

const providerRights = (value: unknown): SearchProviderRights => {
	if (
		value === 'public-domain-source' ||
		value === 'rights-labelled-source' ||
		value === 'unverified-third-party'
	) {
		return value
	}
	throw invalidResponse('Search provider included invalid rights metadata')
}

const providerState = (value: unknown): SearchProviderState => {
	if (value === 'ok' || value === 'error') {
		return value
	}
	throw invalidResponse('Search provider report included an invalid state')
}

const parseProvider = (value: unknown): SearchProviderDescriptor => {
	if (!isRecord(value)) {
		throw invalidResponse('Search provider is invalid')
	}
	if (typeof value.defaultEnabled !== 'boolean') {
		throw invalidResponse('Search provider included an invalid defaultEnabled')
	}
	return {
		defaultEnabled: value.defaultEnabled,
		homepage: requiredString(value, 'homepage', 'Search provider'),
		id: requiredString(value, 'id', 'Search provider'),
		kind: providerKind(value.kind),
		label: requiredString(value, 'label', 'Search provider'),
		rights: providerRights(value.rights),
	}
}

const parseSearchResult = (value: unknown): AudiobookSearchResult => {
	if (!isRecord(value)) {
		throw invalidResponse('Audiobook search result is invalid')
	}
	const context = 'Audiobook search result'
	const coverUrl = optionalString(value, 'coverUrl', context)
	const description = optionalString(value, 'description', context)
	const detailUrl = optionalString(value, 'detailUrl', context)
	const downloads = optionalNumber(value, 'downloads', context)
	const durationSeconds = optionalNumber(value, 'durationSeconds', context)
	const format = optionalString(value, 'format', context)
	const language = optionalString(value, 'language', context)
	const publishedAt = optionalString(value, 'publishedAt', context)
	const rightsUrl = optionalString(value, 'rightsUrl', context)
	const sizeBytes = optionalNumber(value, 'sizeBytes', context)
	return {
		authors: stringArray(value, 'authors', context),
		id: requiredString(value, 'id', context),
		providerId: requiredString(value, 'providerId', context),
		title: requiredString(value, 'title', context),
		...(coverUrl ? { coverUrl } : {}),
		...(description ? { description } : {}),
		...(detailUrl ? { detailUrl } : {}),
		...(downloads === undefined ? {} : { downloads }),
		...(durationSeconds === undefined ? {} : { durationSeconds }),
		...(format ? { format } : {}),
		...(language ? { language } : {}),
		...(publishedAt ? { publishedAt } : {}),
		...(rightsUrl ? { rightsUrl } : {}),
		...(sizeBytes === undefined ? {} : { sizeBytes }),
	}
}

const parseProviderReport = (value: unknown): SearchProviderReport => {
	if (!isRecord(value)) {
		throw invalidResponse('Search provider report is invalid')
	}
	const context = 'Search provider report'
	const count = optionalNumber(value, 'count', context)
	const error = optionalString(value, 'error', context)
	if (count === undefined || !Number.isInteger(count)) {
		throw invalidResponse('Search provider report included an invalid count')
	}
	return {
		count,
		id: requiredString(value, 'id', context),
		label: requiredString(value, 'label', context),
		state: providerState(value.state),
		...(error ? { error } : {}),
	}
}

const parseProviderCatalog = (value: unknown): SearchProviderCatalog => {
	if (!(isRecord(value) && Array.isArray(value.providers))) {
		throw invalidResponse('Search provider catalog is invalid')
	}
	return { providers: value.providers.map(parseProvider) }
}

const parseSearchResponse = (value: unknown): AudiobookSearchResponse => {
	if (
		!(
			isRecord(value) &&
			Array.isArray(value.results) &&
			Array.isArray(value.providers)
		)
	) {
		throw invalidResponse('Audiobook search response is invalid')
	}
	return {
		providers: value.providers.map(parseProviderReport),
		query: requiredString(value, 'query', 'Audiobook search response'),
		results: value.results.map(parseSearchResult),
	}
}

const parseRegistration = (value: unknown): ResolvedTorrentRegistration => {
	if (!isRecord(value)) {
		throw invalidResponse('Resolved torrent registration is invalid')
	}
	if (typeof value.metadataReady !== 'boolean') {
		throw invalidResponse(
			'Resolved torrent registration included an invalid metadataReady'
		)
	}
	return {
		infoHash: requiredString(value, 'infoHash', 'Resolved torrent registration')
			.trim()
			.toLowerCase(),
		metadataReady: value.metadataReady,
	}
}

const responseError = async (response: Response): Promise<SearchApiError> => {
	let code = 'request_failed'
	let message =
		response.statusText || `Request failed with status ${response.status}`
	try {
		const value = (await response.json()) as unknown
		if (isRecord(value)) {
			const error = isRecord(value.error) ? value.error : value
			const { code: responseCode, message: responseMessage } = error
			if (typeof responseCode === 'string') {
				code = responseCode
			}
			if (typeof responseMessage === 'string') {
				message = responseMessage
			}
		}
	} catch {
		// The HTTP status text remains the most useful available error.
	}
	return new SearchApiError(response.status, code, message)
}

export class SearchApiClient {
	private readonly fetcher: Fetcher

	constructor({ fetcher = defaultFetcher }: SearchApiClientOptions = {}) {
		this.fetcher = fetcher
	}

	async getProviders(signal?: AbortSignal): Promise<SearchProviderCatalog> {
		const response = await this.fetcher(`${API_ROOT}/providers`, { signal })
		if (!response.ok) {
			throw await responseError(response)
		}
		return parseProviderCatalog((await response.json()) as unknown)
	}

	async search(
		query: string,
		optionalProviderIds: readonly string[],
		signal?: AbortSignal
	): Promise<AudiobookSearchResponse> {
		const parameters = new URLSearchParams({ q: query.trim() })
		const providerIds = [
			...new Set(
				optionalProviderIds
					.map((providerId) => providerId.trim())
					.filter(Boolean)
			),
		].sort()
		if (providerIds.length > 0) {
			parameters.set('providers', providerIds.join(','))
		}
		const response = await this.fetcher(`${API_ROOT}?${parameters}`, { signal })
		if (!response.ok) {
			throw await responseError(response)
		}
		return parseSearchResponse((await response.json()) as unknown)
	}

	async resolve(
		providerId: string,
		resultId: string,
		signal?: AbortSignal
	): Promise<ResolvedTorrentRegistration> {
		const response = await this.fetcher(`${API_ROOT}/resolve`, {
			body: JSON.stringify({ providerId, resultId }),
			headers: { 'Content-Type': 'application/json' },
			method: 'POST',
			signal,
		})
		if (!response.ok) {
			throw await responseError(response)
		}
		return parseRegistration((await response.json()) as unknown)
	}
}

export const searchApi = new SearchApiClient()

export const getSearchProviders = (
	signal?: AbortSignal
): Promise<SearchProviderCatalog> => searchApi.getProviders(signal)

export const searchAudiobooks = (
	query: string,
	optionalProviderIds: readonly string[],
	signal?: AbortSignal
): Promise<AudiobookSearchResponse> =>
	searchApi.search(query, optionalProviderIds, signal)

export const resolveAudiobookResult = (
	providerId: string,
	resultId: string,
	signal?: AbortSignal
): Promise<ResolvedTorrentRegistration> =>
	searchApi.resolve(providerId, resultId, signal)

export type AudiobookProviderId =
	| 'audiobook-bay'
	| 'internet-archive'
	| 'librivox'

export type AudiobookProviderKind = 'free' | 'tracker'

export type AudiobookProviderRights =
	| 'public-domain-source'
	| 'rights-labelled-source'
	| 'unverified-third-party'

export interface AudiobookProviderDescriptor {
	defaultEnabled: boolean
	homepage: string
	id: AudiobookProviderId
	kind: AudiobookProviderKind
	label: string
	rights: AudiobookProviderRights
}

export interface AudiobookSearchResult {
	authors: string[]
	coverUrl?: string
	description?: string
	detailUrl?: string
	downloads?: number
	durationSeconds?: number
	format?: string
	id: string
	language?: string
	providerId: AudiobookProviderId
	publishedAt?: string
	rightsUrl?: string
	sizeBytes?: number
	title: string
}

export interface AudiobookSearchOptions {
	signal?: AbortSignal
}

export interface AudiobookProvider {
	descriptor: AudiobookProviderDescriptor
	resolve: (
		resultId: string,
		options?: AudiobookSearchOptions
	) => Promise<string>
	search: (
		query: string,
		options?: AudiobookSearchOptions
	) => Promise<AudiobookSearchResult[]>
}

export interface AudiobookProviderStatus {
	count: number
	error?: string
	id: AudiobookProviderId
	label: string
	state: 'error' | 'ok'
}

export interface AudiobookSearchResponse {
	providers: AudiobookProviderStatus[]
	query: string
	results: AudiobookSearchResult[]
}

export type SearchFetcher = (
	input: RequestInfo | URL,
	init?: RequestInit
) => Promise<Response>

export interface AudiobookSearchEndpoints {
	archiveDetailsBaseUrl: string
	archiveDownloadBaseUrl: string
	archiveImageBaseUrl: string
	archiveMetadataBaseUrl: string
	audiobookBayBaseUrl: string
	internetArchiveSearchUrl: string
	librivoxApiUrl: string
}

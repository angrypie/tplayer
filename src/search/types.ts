export type SearchProviderKind = 'free' | 'tracker'

export type SearchProviderRights =
	| 'public-domain-source'
	| 'rights-labelled-source'
	| 'unverified-third-party'

export interface SearchProviderDescriptor {
	defaultEnabled: boolean
	homepage: string
	id: string
	kind: SearchProviderKind
	label: string
	rights: SearchProviderRights
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
	providerId: string
	publishedAt?: string
	rightsUrl?: string
	sizeBytes?: number
	title: string
}

export type SearchProviderState = 'error' | 'ok'

export interface SearchProviderReport {
	count: number
	error?: string
	id: string
	label: string
	state: SearchProviderState
}

export interface AudiobookSearchResponse {
	providers: SearchProviderReport[]
	query: string
	results: AudiobookSearchResult[]
}

export interface SearchProviderCatalog {
	providers: SearchProviderDescriptor[]
}

export interface ResolvedTorrentRegistration {
	infoHash: string
	metadataReady: boolean
}

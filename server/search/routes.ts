import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { HttpError } from '../errors'
import type { TorrentManager } from '../torrent/manager'
import {
	type AudiobookSearchService,
	assertSearchRequestActive,
} from './service'
import type { AudiobookProviderId } from './types'

const MAXIMUM_QUERY_LENGTH = 160
const PROVIDER_IDS = new Set<AudiobookProviderId>([
	'audiobook-bay',
	'internet-archive',
	'librivox',
])

interface SearchRoutesDependencies {
	manager: TorrentManager
	searchService: AudiobookSearchService
}

interface ResolveSearchBody {
	providerId?: unknown
	resultId?: unknown
}

const optionalProviders = (
	value: string | undefined
): Set<AudiobookProviderId> => {
	const selected = new Set<AudiobookProviderId>()
	for (const rawId of value?.split(',') ?? []) {
		const id = rawId.trim()
		if (!id) {
			continue
		}
		if (!PROVIDER_IDS.has(id as AudiobookProviderId)) {
			throw new HttpError(
				422,
				'unknown_search_provider',
				`Unknown search provider: ${id}`
			)
		}
		selected.add(id as AudiobookProviderId)
	}
	return selected
}

const providerId = (value: unknown): AudiobookProviderId => {
	if (
		typeof value !== 'string' ||
		!PROVIDER_IDS.has(value as AudiobookProviderId)
	) {
		throw new HttpError(
			422,
			'unknown_search_provider',
			'Search provider is not available'
		)
	}
	return value as AudiobookProviderId
}

export const createSearchRoutes = ({
	manager,
	searchService,
}: SearchRoutesDependencies): Hono => {
	const routes = new Hono()
	routes.use(
		'/search/resolve',
		bodyLimit({
			maxSize: 8 * 1024,
			onError: (context) =>
				context.json(
					{
						error: {
							code: 'body_too_large',
							message: 'Request body exceeds 8 KiB',
						},
					},
					413
				),
		})
	)

	routes.get('/search/providers', (context) =>
		context.json({ providers: searchService.descriptors() })
	)

	routes.get('/search', async (context) => {
		const query = (context.req.query('q') ?? '').trim()
		if (!query) {
			throw new HttpError(
				400,
				'search_query_required',
				'Enter an audiobook title or author'
			)
		}
		if (query.length > MAXIMUM_QUERY_LENGTH) {
			throw new HttpError(
				422,
				'search_query_too_long',
				`Search query cannot exceed ${MAXIMUM_QUERY_LENGTH} characters`
			)
		}
		return context.json(
			await searchService.search(
				query,
				optionalProviders(context.req.query('providers')),
				{ signal: context.req.raw.signal }
			)
		)
	})

	routes.post('/search/resolve', async (context) => {
		let parsedBody: unknown
		try {
			parsedBody = await context.req.json<unknown>()
		} catch (value) {
			// biome-ignore lint/style/useErrorCause: HttpError forwards cause through its options argument.
			throw new HttpError(
				400,
				'invalid_json',
				'Request body must be valid JSON',
				{},
				{ cause: value }
			)
		}
		if (
			typeof parsedBody !== 'object' ||
			parsedBody === null ||
			Array.isArray(parsedBody)
		) {
			throw new HttpError(
				400,
				'invalid_json_body',
				'Request body must be a JSON object'
			)
		}
		const body = parsedBody as ResolveSearchBody
		if (typeof body.resultId !== 'string' || !body.resultId.trim()) {
			throw new HttpError(
				422,
				'invalid_search_result',
				'Search result identifier is required'
			)
		}
		const reference = await searchService.resolve(
			providerId(body.providerId),
			body.resultId.trim(),
			{ signal: context.req.raw.signal }
		)
		assertSearchRequestActive(context.req.raw.signal)
		return context.json(
			manager.register(reference, { backgroundDownload: true }),
			202
		)
	})

	return routes
}

import { asError } from '../errors'
import type { SearchFetcher } from './types'

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000
const DEFAULT_RESPONSE_LIMIT_BYTES = 2 * 1024 * 1024
const MAXIMUM_REDIRECTS = 3
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
export const SEARCH_USER_AGENT = 'TPlayer/0.0.0 (self-hosted audiobook search)'

export class ProviderRequestError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options)
		this.name = 'ProviderRequestError'
	}
}

interface ProviderRequestOptions {
	accept: string
	label: string
	maxBytes?: number
	signal?: AbortSignal
	timeoutMs?: number
}

const combineWithTimeout = (
	signal: AbortSignal | undefined,
	timeoutMs: number
): { cleanup: () => void; signal: AbortSignal } => {
	const controller = new AbortController()
	const abortFromParent = (): void => controller.abort(signal?.reason)
	if (signal?.aborted) {
		abortFromParent()
	} else {
		signal?.addEventListener('abort', abortFromParent, { once: true })
	}
	const timeout = setTimeout(() => {
		controller.abort(new Error('Provider request timed out'))
	}, timeoutMs)
	return {
		cleanup: () => {
			clearTimeout(timeout)
			signal?.removeEventListener('abort', abortFromParent)
		},
		signal: controller.signal,
	}
}

const readLimitedText = async (
	response: Response,
	maximumBytes: number,
	label: string
): Promise<string> => {
	const declaredLength = Number(response.headers.get('content-length') ?? 0)
	if (declaredLength > maximumBytes) {
		throw new ProviderRequestError(`${label} response was too large`)
	}
	if (!response.body) {
		return ''
	}
	const reader = response.body.getReader()
	const chunks: Uint8Array[] = []
	let totalBytes = 0
	const readNextChunk = async (): Promise<void> => {
		const { done, value } = await reader.read()
		if (done) {
			return
		}
		totalBytes += value.byteLength
		if (totalBytes > maximumBytes) {
			await reader.cancel()
			throw new ProviderRequestError(`${label} response was too large`)
		}
		chunks.push(value)
		await readNextChunk()
	}
	try {
		await readNextChunk()
	} finally {
		reader.releaseLock()
	}
	const bytes = new Uint8Array(totalBytes)
	let offset = 0
	for (const chunk of chunks) {
		bytes.set(chunk, offset)
		offset += chunk.byteLength
	}
	return new TextDecoder().decode(bytes)
}

const fetchProviderResponse = async (
	fetcher: SearchFetcher,
	url: URL,
	init: RequestInit,
	allowedOrigin: string,
	redirectCount = 0
): Promise<Response> => {
	const response = await fetcher(url, { ...init, redirect: 'manual' })
	if (!REDIRECT_STATUSES.has(response.status)) {
		return response
	}
	if (redirectCount >= MAXIMUM_REDIRECTS) {
		throw new ProviderRequestError('Provider returned too many redirects')
	}
	const location = response.headers.get('location')
	if (!location) {
		throw new ProviderRequestError(
			'Provider returned a redirect without a location'
		)
	}
	const destination = new URL(location, url)
	const staysOnApprovedOrigin =
		destination.origin === allowedOrigin &&
		!destination.username &&
		!destination.password
	if (!staysOnApprovedOrigin) {
		throw new ProviderRequestError(
			'Provider redirected outside its approved origin'
		)
	}
	if (response.body) {
		await response.body.cancel()
	}
	return await fetchProviderResponse(
		fetcher,
		destination,
		init,
		allowedOrigin,
		redirectCount + 1
	)
}

export const requestProviderText = async (
	fetcher: SearchFetcher,
	url: URL,
	{
		accept,
		label,
		maxBytes = DEFAULT_RESPONSE_LIMIT_BYTES,
		signal,
		timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
	}: ProviderRequestOptions
): Promise<{ response: Response; text: string }> => {
	const combined = combineWithTimeout(signal, timeoutMs)
	try {
		const response = await fetchProviderResponse(
			fetcher,
			url,
			{
				headers: {
					Accept: accept,
					'User-Agent': SEARCH_USER_AGENT,
				},
				signal: combined.signal,
			},
			url.origin
		)
		return {
			response,
			text: await readLimitedText(response, maxBytes, label),
		}
	} catch (value) {
		if (signal?.aborted) {
			throw signal.reason instanceof Error
				? signal.reason
				: new Error('Search request was cancelled')
		}
		if (value instanceof ProviderRequestError) {
			throw value
		}
		throw new ProviderRequestError(
			`${label} request failed: ${asError(value).message}`,
			{ cause: value }
		)
	} finally {
		combined.cleanup()
	}
}

export const parseJsonResponse = (text: string, label: string): unknown => {
	try {
		return JSON.parse(text) as unknown
	} catch (value) {
		throw new ProviderRequestError(`${label} returned invalid JSON`, {
			cause: value,
		})
	}
}

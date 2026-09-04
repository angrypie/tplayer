const SETTINGS_URL = '/api/settings/transcription'
const API_ROOT = '/api/torrents'
const CAPTION_CONTENT_TYPE = 'application/vnd.tplayer.captions'
const CAPTION_UPDATED_AT_HEADER = 'X-TPlayer-Caption-Updated-At'

type Fetcher = (
	...arguments_: Parameters<typeof fetch>
) => ReturnType<typeof fetch>

export interface TranscriptionSettings {
	automaticTranscription: boolean
	cleanupPending: boolean
}

export type TranscriptionState =
	| 'cancelled'
	| 'completed'
	| 'failed'
	| 'preparing'
	| 'queued'
	| 'transcribing'

export interface TranscriptionError {
	ambiguous: boolean
	code: string
	message: string
	retryable: boolean
}

export interface CompletedCaptionMetadata {
	byteLength: number
	cueCount: number
	durationMilliseconds: number
	etag: string
	formatVersion: number
	language?: string
	updatedAt: string
	url: string
}

export interface TranscriptionStatus {
	attempt: number
	captions?: CompletedCaptionMetadata
	cleanupPending?: boolean
	createdAt: string
	error?: TranscriptionError
	fileId: string
	fileLength: number
	finishedAt?: string
	infoHash: string
	path: string[]
	processedMilliseconds: number
	queueBlockedByCleanup?: boolean
	queuedAhead?: number
	queuePosition?: number
	startedAt?: string
	state: TranscriptionState
	totalMilliseconds?: number
	trigger?: 'automatic' | 'manual'
	updatedAt: string
	watchdogDeadlineAt?: string
	watchdogRemainingMilliseconds?: number
}

export type CaptionDownload =
	| { kind: 'missing' }
	| { artifactUpdatedAt: string; kind: 'not-modified' }
	| {
			artifactUpdatedAt: string
			bytes: ArrayBuffer
			etag: string
			kind: 'track'
	  }

export interface CaptionApiOptions {
	fetcher?: Fetcher
}

export class CaptionApiError extends Error {
	readonly code: string
	readonly status: number

	constructor(status: number, code: string, message: string) {
		super(message)
		this.name = 'CaptionApiError'
		this.code = code
		this.status = status
	}
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value)

const normalizeInfoHash = (infoHash: string): string =>
	infoHash.trim().toLowerCase()

const fileRoute = (infoHash: string, fileId: string, suffix: string): string =>
	`${API_ROOT}/${encodeURIComponent(normalizeInfoHash(infoHash))}/files/${encodeURIComponent(fileId)}/${suffix}`

const readString = (
	value: Record<string, unknown>,
	key: string
): string | undefined =>
	typeof value[key] === 'string' ? value[key] : undefined

const readNumber = (
	value: Record<string, unknown>,
	key: string
): number | undefined => {
	const candidate = value[key]
	return typeof candidate === 'number' && Number.isFinite(candidate)
		? candidate
		: undefined
}

const readNonnegativeInteger = (
	value: Record<string, unknown>,
	key: string
): number | undefined => {
	const candidate = readNumber(value, key)
	return candidate !== undefined &&
		Number.isInteger(candidate) &&
		candidate >= 0
		? candidate
		: undefined
}

const readPositiveInteger = (
	value: Record<string, unknown>,
	key: string
): number | undefined => {
	const candidate = readNonnegativeInteger(value, key)
	return candidate !== undefined && candidate > 0 ? candidate : undefined
}

const readNonnegativeNumber = (
	value: Record<string, unknown>,
	key: string
): number | undefined => {
	const candidate = readNumber(value, key)
	return candidate !== undefined && candidate >= 0 ? candidate : undefined
}

const readBoolean = (
	value: Record<string, unknown>,
	key: string
): boolean | undefined =>
	typeof value[key] === 'boolean' ? value[key] : undefined

const responseError = async (response: Response): Promise<CaptionApiError> => {
	let payload: unknown
	try {
		payload = await response.json()
	} catch {
		payload = null
	}
	const error =
		isRecord(payload) && isRecord(payload.error) ? payload.error : {}
	const code = readString(error, 'code') ?? `http_${response.status}`
	const message =
		readString(error, 'message') ??
		`Caption request failed with HTTP ${response.status}`
	return new CaptionApiError(response.status, code, message)
}

const transcriptionState = (value: unknown): TranscriptionState | null => {
	switch (value) {
		case 'cancelled':
		case 'completed':
		case 'failed':
		case 'preparing':
		case 'queued':
		case 'transcribing':
			return value
		default:
			return null
	}
}

const normalizedPath = (value: unknown): string[] => {
	if (!Array.isArray(value)) {
		return []
	}
	return value.filter(
		(pathPart): pathPart is string =>
			typeof pathPart === 'string' && pathPart.length > 0
	)
}

const parseTranscriptionError = (
	value: unknown
): TranscriptionError | undefined => {
	if (!isRecord(value)) {
		return undefined
	}
	const code = readString(value, 'code')
	const message = readString(value, 'message')
	if (!(code && message)) {
		return undefined
	}
	return {
		ambiguous: readBoolean(value, 'ambiguous') ?? false,
		code,
		message,
		retryable: readBoolean(value, 'retryable') ?? false,
	}
}

const parseCaptionMetadata = (
	value: unknown
): CompletedCaptionMetadata | undefined => {
	if (!isRecord(value)) {
		return undefined
	}
	const byteLength = readNumber(value, 'byteLength')
	const cueCount = readNumber(value, 'cueCount')
	const durationMilliseconds = readNumber(value, 'durationMilliseconds')
	const etag = readString(value, 'etag')
	const formatVersion = readNumber(value, 'formatVersion')
	const updatedAt = readString(value, 'updatedAt')
	const url = readString(value, 'url')
	if (
		byteLength === undefined ||
		cueCount === undefined ||
		durationMilliseconds === undefined ||
		!etag ||
		formatVersion === undefined ||
		!(updatedAt && Number.isFinite(Date.parse(updatedAt))) ||
		!url
	) {
		return undefined
	}
	const language = readString(value, 'language')
	return {
		byteLength,
		cueCount,
		durationMilliseconds,
		etag,
		formatVersion,
		...(language ? { language } : {}),
		updatedAt,
		url,
	}
}

const parseQueueCleanup = (
	value: Record<string, unknown>
): { queueBlockedByCleanup?: true } =>
	readBoolean(value, 'queueBlockedByCleanup') === true
		? { queueBlockedByCleanup: true }
		: {}

const parseStatus = (value: unknown): TranscriptionStatus => {
	if (!isRecord(value)) {
		throw new Error('Transcription status is not an object')
	}
	const state = transcriptionState(value.state)
	const infoHash = readString(value, 'infoHash')
	const fileIdValue = value.fileId
	const fileId =
		typeof fileIdValue === 'string' || typeof fileIdValue === 'number'
			? String(fileIdValue)
			: ''
	const fileLength = readNumber(value, 'fileLength')
	const attempt = readNumber(value, 'attempt')
	const createdAt = readString(value, 'createdAt')
	const processedMilliseconds = readNumber(value, 'processedMilliseconds')
	const updatedAt = readString(value, 'updatedAt')
	if (
		!(state && infoHash && fileId) ||
		fileLength === undefined ||
		attempt === undefined ||
		!createdAt ||
		processedMilliseconds === undefined ||
		!updatedAt
	) {
		throw new Error('Transcription status is missing required fields')
	}
	const captions = parseCaptionMetadata(value.captions)
	const cleanupPending = readBoolean(value, 'cleanupPending')
	const error = parseTranscriptionError(value.error)
	const finishedAt = readString(value, 'finishedAt')
	const queuedAhead = readNonnegativeInteger(value, 'queuedAhead')
	const queuePosition = readPositiveInteger(value, 'queuePosition')
	const startedAt = readString(value, 'startedAt')
	const totalMilliseconds = readNumber(value, 'totalMilliseconds')
	const watchdogDeadlineAt = readString(value, 'watchdogDeadlineAt')
	const watchdogRemainingMilliseconds = readNonnegativeNumber(
		value,
		'watchdogRemainingMilliseconds'
	)
	const trigger =
		value.trigger === 'automatic' || value.trigger === 'manual'
			? value.trigger
			: undefined
	return {
		attempt,
		createdAt,
		fileId,
		fileLength,
		infoHash: normalizeInfoHash(infoHash),
		path: normalizedPath(value.path),
		processedMilliseconds,
		state,
		updatedAt,
		...(captions ? { captions } : {}),
		...(cleanupPending === true ? { cleanupPending: true } : {}),
		...(error ? { error } : {}),
		...(finishedAt ? { finishedAt } : {}),
		...(queuedAhead === undefined ? {} : { queuedAhead }),
		...parseQueueCleanup(value),
		...(queuePosition === undefined ? {} : { queuePosition }),
		...(startedAt ? { startedAt } : {}),
		...(totalMilliseconds === undefined ? {} : { totalMilliseconds }),
		...(trigger ? { trigger } : {}),
		...(watchdogDeadlineAt && Number.isFinite(Date.parse(watchdogDeadlineAt))
			? { watchdogDeadlineAt }
			: {}),
		...(watchdogRemainingMilliseconds === undefined
			? {}
			: { watchdogRemainingMilliseconds }),
	}
}

export class CaptionApiClient {
	private readonly fetcher: Fetcher

	constructor({ fetcher }: CaptionApiOptions = {}) {
		this.fetcher = fetcher ?? ((input, init) => globalThis.fetch(input, init))
	}

	async getSettings(signal?: AbortSignal): Promise<TranscriptionSettings> {
		const response = await this.fetcher(SETTINGS_URL, {
			cache: 'no-store',
			credentials: 'same-origin',
			signal,
		})
		if (!response.ok) {
			throw await responseError(response)
		}
		const value = (await response.json()) as unknown
		if (!isRecord(value) || typeof value.automaticTranscription !== 'boolean') {
			throw new Error('Transcription settings response is invalid')
		}
		return {
			automaticTranscription: value.automaticTranscription,
			cleanupPending: value.cleanupPending === true,
		}
	}

	async updateSettings(
		automaticTranscription: boolean,
		signal?: AbortSignal
	): Promise<TranscriptionSettings> {
		const response = await this.fetcher(SETTINGS_URL, {
			body: JSON.stringify({ automaticTranscription }),
			cache: 'no-store',
			credentials: 'same-origin',
			headers: { 'Content-Type': 'application/json' },
			method: 'PUT',
			signal,
		})
		if (!response.ok) {
			throw await responseError(response)
		}
		const value = (await response.json()) as unknown
		if (!isRecord(value) || typeof value.automaticTranscription !== 'boolean') {
			throw new Error('Transcription settings response is invalid')
		}
		return {
			automaticTranscription: value.automaticTranscription,
			cleanupPending: value.cleanupPending === true,
		}
	}

	async getStatus(
		infoHash: string,
		fileId: string,
		signal?: AbortSignal
	): Promise<TranscriptionStatus | null> {
		const response = await this.fetcher(
			fileRoute(infoHash, fileId, 'transcription'),
			{
				cache: 'no-store',
				credentials: 'same-origin',
				signal,
			}
		)
		if (response.status === 404) {
			return null
		}
		if (!response.ok) {
			throw await responseError(response)
		}
		return parseStatus((await response.json()) as unknown)
	}

	async start(
		infoHash: string,
		fileId: string,
		signal?: AbortSignal
	): Promise<TranscriptionStatus> {
		const response = await this.fetcher(
			fileRoute(infoHash, fileId, 'transcription'),
			{
				cache: 'no-store',
				credentials: 'same-origin',
				method: 'POST',
				signal,
			}
		)
		if (!response.ok) {
			throw await responseError(response)
		}
		return parseStatus((await response.json()) as unknown)
	}

	async cancel(
		infoHash: string,
		fileId: string,
		signal?: AbortSignal
	): Promise<void> {
		const response = await this.fetcher(
			fileRoute(infoHash, fileId, 'transcription'),
			{
				cache: 'no-store',
				credentials: 'same-origin',
				method: 'DELETE',
				signal,
			}
		)
		if (!(response.ok || response.status === 404)) {
			throw await responseError(response)
		}
	}

	async getTrack(
		infoHash: string,
		fileId: string,
		etag: string | undefined,
		signal?: AbortSignal
	): Promise<CaptionDownload> {
		const headers = new Headers({ Accept: CAPTION_CONTENT_TYPE })
		if (etag) {
			headers.set('If-None-Match', etag)
		}
		const response = await this.fetcher(
			fileRoute(infoHash, fileId, 'captions'),
			{
				cache: 'no-store',
				credentials: 'same-origin',
				headers,
				signal,
			}
		)
		if (response.status === 404) {
			return { kind: 'missing' }
		}
		if (response.status !== 304 && !response.ok) {
			throw await responseError(response)
		}
		const artifactUpdatedAt = response.headers
			.get(CAPTION_UPDATED_AT_HEADER)
			?.trim()
		if (
			!(artifactUpdatedAt && Number.isFinite(Date.parse(artifactUpdatedAt)))
		) {
			throw new Error('Caption response is missing its artifact revision')
		}
		if (response.status === 304) {
			return { artifactUpdatedAt, kind: 'not-modified' }
		}
		const responseEtag = response.headers.get('etag')?.trim()
		if (!responseEtag) {
			throw new Error('Caption response is missing its ETag')
		}
		return {
			artifactUpdatedAt,
			bytes: await response.arrayBuffer(),
			etag: responseEtag,
			kind: 'track',
		}
	}
}

export const captionApi = new CaptionApiClient()

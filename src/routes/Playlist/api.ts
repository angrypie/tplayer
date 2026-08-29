import { type BookStorage, type PlaybackState, storage } from '~/storage'

const API_ROOT = '/api/torrents'
const DEFAULT_MIME_TYPE = 'application/octet-stream'

type Fetcher = (
	...arguments_: Parameters<typeof fetch>
) => ReturnType<typeof fetch>

export interface TorrentFileReference {
	id: string
	mimeType?: string
	path: readonly string[]
}

export interface TorrentFileDto extends TorrentFileReference {
	cached?: boolean
	downloaded?: number
	isCombined?: boolean
	length: number
	name: string
	progress?: number
	state?: '' | 'loading' | 'ready'
}

export interface TorrentInfoDto extends Record<string, unknown> {
	downloaded?: number
	downloadSpeed?: number
	files: TorrentFileDto[]
	infoHash: string
	length: number
	magnetUri?: string
	name: string
	numPeers?: number
	progress?: number
	ready?: boolean
	state?: PlaybackState
}

export interface TorrentRegistration {
	infoHash: string
	metadataReady: boolean
}

export interface AvailableTorrent {
	cachedBytes: number
	firstSeen: Date
	infoHash: string
	lastSeen: Date
	name: string
}

export type PreloadState = 'completed' | 'failed' | 'running'

export interface PreloadStatus {
	downloadedBytes: number
	error?: string
	finishedAt?: string
	infoHash: string
	startedAt: string
	state: PreloadState
	totalBytes: number
}

export interface TorrentApiClientOptions {
	fetcher?: Fetcher
	repository?: BookStorage
}

export class ApiError extends Error {
	readonly code: string
	readonly status: number

	constructor(status: number, code: string, message: string) {
		super(message)
		this.name = 'ApiError'
		this.code = code
		this.status = status
	}
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value)

const normalizeInfoHash = (infoHash: string): string =>
	infoHash.trim().toLowerCase()

const pathKey = (path: readonly string[]): string => path.join('/')

const isPath = (
	value: TorrentFileReference | readonly string[]
): value is readonly string[] => Array.isArray(value)

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

const appendPathParts = (value: unknown, parts: string[]): void => {
	if (Array.isArray(value)) {
		for (const entry of value) {
			appendPathParts(entry, parts)
		}
		return
	}
	if (typeof value === 'string' && value.length > 0) {
		parts.push(value)
	}
}

const normalizedPath = (value: unknown, fallbackName: string): string[] => {
	if (Array.isArray(value)) {
		const parts: string[] = []
		appendPathParts(value, parts)
		if (parts.length > 0) {
			return parts
		}
	}
	if (typeof value === 'string' && value.length > 0) {
		return value.split('/').filter(Boolean)
	}
	return fallbackName ? [fallbackName] : []
}

const lastPathPart = (path: readonly string[]): string | undefined => {
	const [lastPart] = path.slice(-1)
	return lastPart
}

const normalizeFile = (
	value: unknown,
	index: number,
	fallbackName: string
): TorrentFileDto => {
	const file = isRecord(value) ? value : {}
	const explicitName =
		readString(file, 'name.utf-8') ?? readString(file, 'name')
	const path = normalizedPath(
		file['path.utf-8'] ?? file.path,
		explicitName ?? fallbackName
	)
	const finalName =
		explicitName || lastPathPart(path) || fallbackName || `File ${index + 1}`
	return {
		id: readString(file, 'id') ?? String(index),
		length: readNumber(file, 'length') ?? 0,
		mimeType:
			readString(file, 'mimeType') ??
			readString(file, 'content-type') ??
			DEFAULT_MIME_TYPE,
		name: finalName,
		path: path.length > 0 ? path : [finalName],
		...(readNumber(file, 'downloaded') === undefined
			? {}
			: { downloaded: readNumber(file, 'downloaded') }),
		...(readNumber(file, 'progress') === undefined
			? {}
			: { progress: readNumber(file, 'progress') }),
		...(file.isCombined === true ? { isCombined: true } : {}),
	}
}

const normalizeTorrentInfo = (
	value: unknown,
	requestedInfoHash: string
): TorrentInfoDto => {
	if (!isRecord(value)) {
		throw new ApiError(502, 'invalid_response', 'Torrent metadata is invalid')
	}
	const name =
		readString(value, 'name.utf-8') ??
		readString(value, 'name') ??
		'Unknown torrent'
	const rawFiles = Array.isArray(value.files)
		? value.files
		: [
				{
					length:
						readNumber(value, 'length') ??
						readNumber(value, 'totalLength') ??
						0,
					name,
					path: [name],
				},
			]
	const files = rawFiles.map((file, index) => normalizeFile(file, index, name))
	const infoHash = normalizeInfoHash(
		readString(value, 'infoHash') ?? requestedInfoHash
	)
	return {
		...value,
		files,
		infoHash,
		length:
			readNumber(value, 'length') ??
			readNumber(value, 'totalLength') ??
			files.reduce((total, file) => total + file.length, 0),
		name,
		...(readString(value, 'magnetUri')
			? { magnetUri: readString(value, 'magnetUri') }
			: {}),
	}
}

const responseError = async (response: Response): Promise<ApiError> => {
	let code = 'request_failed'
	let message =
		response.statusText || `Request failed with status ${response.status}`
	try {
		const body = (await response.clone().json()) as unknown
		if (isRecord(body)) {
			if (typeof body.error === 'string') {
				message = body.error
			} else if (isRecord(body.error)) {
				code = readString(body.error, 'code') ?? code
				message = readString(body.error, 'message') ?? message
			}
		}
	} catch {
		// Non-JSON failures still carry a useful HTTP status message.
	}
	return new ApiError(response.status, code, message)
}

const readDate = (value: unknown): Date => {
	const date = new Date(typeof value === 'string' ? value : 0)
	if (Number.isNaN(date.getTime())) {
		throw new ApiError(
			502,
			'invalid_response',
			'Server returned an invalid date'
		)
	}
	return date
}

const directFileUrl = (infoHash: string, fileId: string): string =>
	`${API_ROOT}/${encodeURIComponent(normalizeInfoHash(infoHash))}/files/${encodeURIComponent(fileId)}`

export class TorrentApiClient {
	private readonly fetcher: Fetcher
	private readonly offlineDownloads = new Map<string, Promise<Blob>>()
	private readonly repository: BookStorage

	constructor({ fetcher, repository = storage }: TorrentApiClientOptions = {}) {
		this.fetcher = fetcher ?? ((input, init) => globalThis.fetch(input, init))
		this.repository = repository
	}

	async getTorrentInfo(infoHash: string): Promise<TorrentInfoDto> {
		const normalizedHash = normalizeInfoHash(infoHash)
		const stored = await this.repository.getTorrent(normalizedHash)
		if (stored) {
			return await this.withOfflineState(
				normalizeTorrentInfo(stored.info, normalizedHash),
				stored.state
			)
		}

		const response = await this.fetcher(
			`${API_ROOT}/${encodeURIComponent(normalizedHash)}`
		)
		if (!response.ok) {
			throw await responseError(response)
		}
		const details = normalizeTorrentInfo(await response.json(), normalizedHash)
		await this.repository.addTorrent(details.infoHash, details)
		return await this.withOfflineState(details)
	}

	async getPlayableUrl(
		infoHash: string,
		file: TorrentFileReference
	): Promise<string> {
		const normalizedHash = normalizeInfoHash(infoHash)
		const stored = await this.repository.getFile(
			normalizedHash,
			pathKey(file.path)
		)
		if (stored) {
			return URL.createObjectURL(stored.file)
		}
		return directFileUrl(normalizedHash, file.id)
	}

	async downloadFileForOffline(
		infoHash: string,
		file: TorrentFileReference
	): Promise<Blob> {
		const normalizedHash = normalizeInfoHash(infoHash)
		const storedPath = pathKey(file.path)
		const stored = await this.repository.getFile(normalizedHash, storedPath)
		if (stored) {
			return stored.file
		}

		const key = `${normalizedHash}\0${storedPath}`
		const activeDownload = this.offlineDownloads.get(key)
		if (activeDownload) {
			return await activeDownload
		}
		const download = this.fetchAndStoreFile(normalizedHash, file, storedPath)
		this.offlineDownloads.set(key, download)
		try {
			return await download
		} finally {
			this.offlineDownloads.delete(key)
		}
	}

	async getFileUrl(
		infoHash: string,
		fileOrPath: TorrentFileReference | readonly string[]
	): Promise<string | null> {
		try {
			const normalizedHash = normalizeInfoHash(infoHash)
			const requestedPath = isPath(fileOrPath) ? fileOrPath : fileOrPath.path
			const stored = await this.repository.getFile(
				normalizedHash,
				pathKey(requestedPath)
			)
			if (stored) {
				return URL.createObjectURL(stored.file)
			}
			const file = isPath(fileOrPath)
				? await this.fileByPath(normalizedHash, fileOrPath)
				: fileOrPath
			const blob = await this.downloadFileForOffline(normalizedHash, file)
			return URL.createObjectURL(blob)
		} catch {
			return null
		}
	}

	async registerTorrent(source: string): Promise<TorrentRegistration> {
		const response = await this.fetcher(API_ROOT, {
			body: JSON.stringify({ torrentId: source.trim() }),
			headers: { 'Content-Type': 'application/json' },
			method: 'POST',
		})
		if (!response.ok) {
			throw await responseError(response)
		}
		const value = (await response.json()) as unknown
		if (!isRecord(value)) {
			throw new ApiError(
				502,
				'invalid_response',
				'Registration response is invalid'
			)
		}
		const infoHash = readString(value, 'infoHash')
		if (!infoHash) {
			throw new ApiError(
				502,
				'invalid_response',
				'Registration response did not include an info hash'
			)
		}
		return {
			infoHash: normalizeInfoHash(infoHash),
			metadataReady: value.metadataReady === true,
		}
	}

	async getAvailableTorrents(): Promise<AvailableTorrent[]> {
		try {
			const response = await this.fetcher(API_ROOT)
			if (!response.ok) {
				throw await responseError(response)
			}
			const value = (await response.json()) as unknown
			if (!Array.isArray(value)) {
				throw new ApiError(502, 'invalid_response', 'Torrent list is invalid')
			}
			return value.map((entry) => {
				if (!isRecord(entry)) {
					throw new ApiError(
						502,
						'invalid_response',
						'Torrent summary is invalid'
					)
				}
				const infoHash =
					readString(entry, 'infoHash') ?? readString(entry, 'info_hash')
				const name = readString(entry, 'name')
				if (!(infoHash && name)) {
					throw new ApiError(
						502,
						'invalid_response',
						'Torrent summary is incomplete'
					)
				}
				return {
					cachedBytes:
						readNumber(entry, 'cachedBytes') ??
						readNumber(entry, 'cached_bytes') ??
						0,
					firstSeen: readDate(entry.firstSeen ?? entry.first_seen),
					infoHash: normalizeInfoHash(infoHash),
					lastSeen: readDate(entry.lastSeen ?? entry.last_seen),
					name,
				}
			})
		} catch {
			return []
		}
	}

	async deleteAvailableTorrent(infoHash: string): Promise<boolean> {
		try {
			const response = await this.fetcher(
				`${API_ROOT}/${encodeURIComponent(normalizeInfoHash(infoHash))}`,
				{ method: 'DELETE' }
			)
			return response.ok
		} catch {
			return false
		}
	}

	async preloadTorrent(infoHash: string): Promise<PreloadState> {
		const response = await this.fetcher(
			`${API_ROOT}/${encodeURIComponent(normalizeInfoHash(infoHash))}/preload`,
			{ method: 'POST' }
		)
		if (!response.ok) {
			throw await responseError(response)
		}
		return this.parsePreloadStatus(await response.json()).state
	}

	async getPreloadStatus(infoHash: string): Promise<PreloadStatus | null> {
		const response = await this.fetcher(
			`${API_ROOT}/${encodeURIComponent(normalizeInfoHash(infoHash))}/preload`
		)
		if (response.status === 404) {
			return null
		}
		if (!response.ok) {
			throw await responseError(response)
		}
		return this.parsePreloadStatus(await response.json())
	}

	async getAudio(
		infoHash: string,
		path: readonly string[]
	): Promise<string | null> {
		try {
			const file = await this.fileByPath(infoHash, path)
			const blob = await this.downloadFileForOffline(infoHash, file)
			return URL.createObjectURL(blob)
		} catch {
			return null
		}
	}

	private async fetchAndStoreFile(
		infoHash: string,
		file: TorrentFileReference,
		storedPath: string
	): Promise<Blob> {
		const response = await this.fetcher(directFileUrl(infoHash, file.id))
		if (!response.ok) {
			throw await responseError(response)
		}
		const blob = await response.blob()
		await this.repository.addFile(infoHash, storedPath, blob)
		return blob
	}

	private async fileByPath(
		infoHash: string,
		path: readonly string[]
	): Promise<TorrentFileDto> {
		const key = pathKey(path)
		const info = await this.getTorrentInfo(infoHash)
		const file = info.files.find((candidate) => pathKey(candidate.path) === key)
		if (!file) {
			throw new ApiError(404, 'file_not_found', 'Torrent file was not found')
		}
		return file
	}

	private parsePreloadStatus(value: unknown): PreloadStatus {
		if (!isRecord(value)) {
			throw new ApiError(502, 'invalid_response', 'Preload status is invalid')
		}
		const state = readString(value, 'state')
		const infoHash = readString(value, 'infoHash')
		const startedAt = readString(value, 'startedAt')
		const isPreloadState =
			state === 'completed' || state === 'failed' || state === 'running'
		if (!(isPreloadState && infoHash && startedAt)) {
			throw new ApiError(
				502,
				'invalid_response',
				'Preload status is incomplete'
			)
		}
		return {
			downloadedBytes: readNumber(value, 'downloadedBytes') ?? 0,
			infoHash: normalizeInfoHash(infoHash),
			startedAt,
			state,
			totalBytes: readNumber(value, 'totalBytes') ?? 0,
			...(readString(value, 'error')
				? { error: readString(value, 'error') }
				: {}),
			...(readString(value, 'finishedAt')
				? { finishedAt: readString(value, 'finishedAt') }
				: {}),
		}
	}

	private async withOfflineState(
		info: TorrentInfoDto,
		state?: PlaybackState
	): Promise<TorrentInfoDto> {
		const files = await this.repository.getAllFilesForTorrent(info.infoHash)
		const cachedPaths = new Set(files.map((file) => file.path))
		return {
			...info,
			files: info.files.map((file) => ({
				...file,
				cached: cachedPaths.has(pathKey(file.path)),
				state: 'ready',
			})),
			...(state ? { state } : {}),
		}
	}
}

export const torrentApi = new TorrentApiClient()

export const getTorrentInfo = (infoHash: string): Promise<TorrentInfoDto> =>
	torrentApi.getTorrentInfo(infoHash)

export const getPlayableUrl = (
	infoHash: string,
	file: TorrentFileReference
): Promise<string> => torrentApi.getPlayableUrl(infoHash, file)

export const downloadFileForOffline = (
	infoHash: string,
	file: TorrentFileReference
): Promise<Blob> => torrentApi.downloadFileForOffline(infoHash, file)

export const getFileUrl = (
	infoHash: string,
	fileOrPath: TorrentFileReference | readonly string[]
): Promise<string | null> => torrentApi.getFileUrl(infoHash, fileOrPath)

export const registerTorrent = (source: string): Promise<TorrentRegistration> =>
	torrentApi.registerTorrent(source)

export const getAvailableTorrents = (): Promise<AvailableTorrent[]> =>
	torrentApi.getAvailableTorrents()

export const deleteAvailableTorrent = (infoHash: string): Promise<boolean> =>
	torrentApi.deleteAvailableTorrent(infoHash)

export const preloadTorrent = (infoHash: string): Promise<PreloadState> =>
	torrentApi.preloadTorrent(infoHash)

export const getPreloadStatus = (
	infoHash: string
): Promise<PreloadStatus | null> => torrentApi.getPreloadStatus(infoHash)

export const getAudio = (
	infoHash: string,
	path: readonly string[]
): Promise<string | null> => torrentApi.getAudio(infoHash, path)

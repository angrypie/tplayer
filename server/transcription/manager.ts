import { createHash } from 'node:crypto'
import {
	CAPTION_FORMAT_VERSION,
	encodeCaptionTrack,
} from '@tplayer/captions/codec'
import { CaptionSegmenter } from '@tplayer/captions/segmenter'
import type { CaptionSegment, TimedWord } from '@tplayer/captions/types'
import type { TranscriptionRuntimeConfig } from '../config'
import type {
	AppDatabase,
	CaptionArtifactMetadata,
	CaptionArtifactRecord,
	TranscriptionJobRecord,
	TranscriptionJobTrigger,
} from '../database'
import { asError, HttpError } from '../errors'
import type { AppLogger } from '../logger'
import type { TorrentFileDetails, TorrentManager } from '../torrent/manager'
import { normalizeInfoHash } from '../torrent/reference'
import {
	AudioPipelineError,
	type AudioTranscoder,
	FfmpegAudioTranscoder,
} from './audioPipeline'
import { type SpeechProvider, SpeechProviderFailure } from './provider'
import { WindowWordStitcher } from './windowStitcher'

const ACTIVE_STATES = new Set(['preparing', 'queued', 'transcribing'])
const MAXIMUM_CANCELLATION_CONFIRMATION_MS = 1000
const TRANSCRIBABLE_AUDIO_EXTENSIONS = new Set([
	'aac',
	'caf',
	'flac',
	'm4a',
	'm4b',
	'mp3',
	'mp4',
	'oga',
	'ogg',
	'opus',
	'wav',
	'weba',
	'webm',
])

export interface CaptionArtifactSummary {
	byteLength: number
	cueCount: number
	durationMilliseconds: number
	etag: string
	formatVersion: number
	language?: string
	updatedAt: string
	url: string
}

export interface TranscriptionErrorSummary {
	ambiguous: boolean
	code: string
	message: string
	retryable: boolean
}

export interface TranscriptionStatus {
	attempt: number
	captions?: CaptionArtifactSummary
	cleanupPending?: boolean
	createdAt: string
	error?: TranscriptionErrorSummary
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
	state: TranscriptionJobRecord['state']
	totalMilliseconds?: number
	trigger: TranscriptionJobTrigger
	updatedAt: string
	watchdogDeadlineAt?: string
	watchdogRemainingMilliseconds?: number
}

export interface TranscriptionHealth {
	activeJobs: number
	automaticTranscription: boolean
	healthy: boolean
	queuedJobs: number
	stalledJobs: number
}

export interface TranscriptionSettingStatus {
	automaticTranscription: boolean
	cleanupPending: boolean
}

export interface TranscriptionManagerOptions {
	config: TranscriptionRuntimeConfig
	database: AppDatabase
	logger: AppLogger
	provider: SpeechProvider
	torrentManager: TorrentManager
	transcoder?: AudioTranscoder
}

interface TerminalJobFailure {
	error: TranscriptionErrorSummary
	state: 'cancelled' | 'failed'
}

interface ActiveJob {
	attempt: number
	controller: AbortController
}

interface JobOwner {
	attempt: number
	key: string
}

interface PendingJob extends JobOwner {}

interface WatchdogDeadline {
	attempt: number
	deadlineAt: string
}

class JobOwnershipLostError extends Error {
	constructor() {
		super('Transcription job ownership changed')
		this.name = 'JobOwnershipLostError'
	}
}

class TranscriptionStalledError extends Error {
	constructor() {
		super('Transcription stopped making progress and was ended by the server.')
		this.name = 'TranscriptionStalledError'
	}
}

class ActivityWatchdog {
	private readonly onDeadline: (deadlineAt: string | null) => void
	private readonly onExpired: (error: TranscriptionStalledError) => void
	private timer: ReturnType<typeof setTimeout> | null = null
	private readonly timeoutMs: number

	constructor(
		timeoutMs: number,
		onDeadline: (deadlineAt: string | null) => void,
		onExpired: (error: TranscriptionStalledError) => void
	) {
		this.timeoutMs = timeoutMs
		this.onDeadline = onDeadline
		this.onExpired = onExpired
	}

	arm(): void {
		this.pause()
		const deadlineAt = new Date(Date.now() + this.timeoutMs).toISOString()
		this.onDeadline(deadlineAt)
		this.timer = setTimeout(() => {
			this.timer = null
			this.onExpired(new TranscriptionStalledError())
		}, this.timeoutMs)
	}

	pause(): void {
		if (this.timer !== null) {
			clearTimeout(this.timer)
			this.timer = null
		}
		this.onDeadline(null)
	}
}

const jobKey = (infoHash: string, torrentFilePath: string): string =>
	`${infoHash}\0${torrentFilePath}`

const filePath = (file: TorrentFileDetails): string => file.path.join('/')

const fileExtension = (fileName: string): string => {
	const extensionSeparator = fileName.lastIndexOf('.')
	return extensionSeparator < 0
		? ''
		: fileName.slice(extensionSeparator + 1).toLowerCase()
}

const isTranscribableAudioFile = (file: TorrentFileDetails): boolean => {
	const [mediaType = ''] = file.mimeType.split(';', 1)
	if (mediaType.trim().toLowerCase().startsWith('audio/')) {
		return true
	}
	const fileName = file.name || file.path.at(-1) || ''
	return TRANSCRIBABLE_AUDIO_EXTENSIONS.has(fileExtension(fileName))
}

const now = (): string => new Date().toISOString()

const captionsUrl = (job: TranscriptionJobRecord): string =>
	`/api/torrents/${encodeURIComponent(job.infoHash)}/files/${encodeURIComponent(job.fileId)}/captions`

const artifactEtag = (
	artifact: Pick<CaptionArtifactMetadata, 'formatVersion' | 'sha256'>
): string => `"tcap${artifact.formatVersion}-${artifact.sha256}"`

const recoveredQueueOrder = (
	left: TranscriptionJobRecord,
	right: TranscriptionJobRecord
): number => {
	const leftQueued = left.state === 'queued'
	const rightQueued = right.state === 'queued'
	if (leftQueued && rightQueued) {
		return (
			left.updatedAt.localeCompare(right.updatedAt) ||
			left.infoHash.localeCompare(right.infoHash) ||
			left.fileId.localeCompare(right.fileId)
		)
	}
	if (leftQueued) {
		return -1
	}
	if (rightQueued) {
		return 1
	}
	return 0
}

const shiftedWord = (word: TimedWord, inputStartMs: number): TimedWord => ({
	...(word.confidence === undefined ? {} : { confidence: word.confidence }),
	endMs: word.endMs + inputStartMs,
	startMs: word.startMs + inputStartMs,
	text: word.text,
})

const majorityLanguage = (languages: readonly string[]): string | undefined => {
	const counts = new Map<string, { count: number; language: string }>()
	let selected: { count: number; language: string } | undefined
	for (const detected of languages) {
		const language = detected.trim()
		if (!language) {
			continue
		}
		const key = language.toLowerCase()
		const current = counts.get(key)
		const next = current
			? { ...current, count: current.count + 1 }
			: { count: 1, language }
		counts.set(key, next)
		if (!selected || next.count > selected.count) {
			selected = next
		}
	}
	return selected?.language
}

const clampSegmentsToDuration = (
	segments: readonly CaptionSegment[],
	durationMs: number
): CaptionSegment[] => {
	const clamped: CaptionSegment[] = []
	for (const segment of segments) {
		if (segment.startMs >= durationMs) {
			continue
		}
		clamped.push({
			endMs: Math.min(segment.endMs, durationMs),
			startMs: segment.startMs,
			text: segment.text,
		})
	}
	return clamped
}

const isAbortError = (value: unknown): boolean =>
	value instanceof Error && value.name === 'AbortError'

const abortError = (): Error => {
	const error = new Error('Transcription was cancelled')
	error.name = 'AbortError'
	return error
}

const signalError = (signal: AbortSignal): Error =>
	signal.reason instanceof Error ? signal.reason : abortError()

const raceWithSignal = async <Value>(
	operation: Promise<Value>,
	signal: AbortSignal
): Promise<Value> => {
	if (signal.aborted) {
		operation.catch(() => undefined)
		throw signalError(signal)
	}
	let onAbort = (): void => undefined
	const aborted = new Promise<never>((_resolve, reject) => {
		onAbort = () => reject(signalError(signal))
		signal.addEventListener('abort', onAbort, { once: true })
	})
	try {
		return await Promise.race([operation, aborted])
	} finally {
		signal.removeEventListener('abort', onAbort)
	}
}

const assertRequestActive = (signal?: AbortSignal): void => {
	if (signal?.aborted) {
		throw new HttpError(499, 'request_cancelled', 'Request was cancelled')
	}
}

export class TranscriptionManager {
	private readonly activeJobs = new Map<string, ActiveJob>()
	private activePromise: Promise<void> | null = null
	private automaticSettingTransition = Promise.resolve()
	private readonly automaticRescans = new Set<string>()
	private readonly cancellingTorrents = new Set<string>()
	private readonly config: TranscriptionRuntimeConfig
	private readonly database: AppDatabase
	private lastQueueTimestampMs: number
	private readonly logger: AppLogger
	private readonly pendingJobs: PendingJob[] = []
	private readonly pendingAttempts = new Map<string, number>()
	private pumpSuspensions = 0
	private readonly purgeAfterCleanup = new Map<string, number>()
	private readonly provider: SpeechProvider
	private readonly state: Record<'closing', boolean> = { closing: false }
	private readonly torrentManager: TorrentManager
	private readonly transcoder: AudioTranscoder
	private readonly unsubscribeCacheCompleted: () => void
	private readonly watchdogDeadlines = new Map<string, WatchdogDeadline>()

	constructor({
		config,
		database,
		logger,
		provider,
		torrentManager,
		transcoder = new FfmpegAudioTranscoder(config.ffmpegPath),
	}: TranscriptionManagerOptions) {
		this.config = config
		this.database = database
		this.lastQueueTimestampMs = database
			.listTranscriptionJobs()
			.reduce(
				(latest, job) => Math.max(latest, Date.parse(job.updatedAt) || 0),
				0
			)
		this.logger = logger
		this.provider = provider
		this.torrentManager = torrentManager
		this.transcoder = transcoder
		this.unsubscribeCacheCompleted = torrentManager.onCacheCompleted(
			(infoHash) => {
				if (this.database.getAutomaticTranscriptionEnabled()) {
					this.queueTorrent(infoHash, 'automatic').catch((error: unknown) => {
						this.logger.warn('Unable to queue automatic transcription', {
							error: asError(error).message,
							infoHash,
						})
					})
				}
			}
		)
	}

	async start(): Promise<void> {
		const automaticEnabled = this.database.getAutomaticTranscriptionEnabled()
		const recoveredJobs = this.database
			.listTranscriptionJobs()
			.sort(recoveredQueueOrder)
		for (const job of recoveredJobs) {
			if (job.state === 'queued') {
				if (job.trigger === 'automatic' && !automaticEnabled) {
					this.database.putTranscriptionJob({
						...job,
						errorAmbiguous: false,
						errorCode: 'automatic_disabled',
						errorMessage: 'Automatic transcription was disabled.',
						errorRetryable: true,
						finishedAt: now(),
						state: 'cancelled',
						updatedAt: now(),
					})
				} else {
					this.enqueue(job)
				}
				continue
			}
			if (job.state === 'preparing' || job.state === 'transcribing') {
				this.database.putTranscriptionJob({
					...job,
					errorAmbiguous: true,
					errorCode: 'server_interrupted',
					errorMessage:
						'Transcription was interrupted and requires an explicit retry.',
					errorRetryable: true,
					finishedAt: now(),
					state: 'failed',
					updatedAt: now(),
				})
			}
		}
		if (automaticEnabled) {
			await this.scanLocallyAvailableTorrents()
		}
	}

	async close(): Promise<void> {
		if (this.state.closing) {
			await this.activePromise
			return
		}
		this.state.closing = true
		this.unsubscribeCacheCompleted()
		for (const { controller } of this.activeJobs.values()) {
			controller.abort(abortError())
		}
		await this.activePromise
	}

	health(): TranscriptionHealth {
		const currentTime = Date.now()
		let stalledJobs = 0
		for (const [key, active] of this.activeJobs) {
			const separator = key.indexOf('\0')
			const job = this.database.getTranscriptionJob(
				key.slice(0, separator),
				key.slice(separator + 1)
			)
			if (
				!(job && job.attempt === active.attempt && ACTIVE_STATES.has(job.state))
			) {
				stalledJobs += 1
				continue
			}
			const deadline = this.watchdogDeadlines.get(key)
			if (
				deadline?.attempt === active.attempt &&
				Date.parse(deadline.deadlineAt) <= currentTime
			) {
				stalledJobs += 1
			}
		}
		return {
			activeJobs: this.activeJobs.size,
			automaticTranscription: this.database.getAutomaticTranscriptionEnabled(),
			healthy: stalledJobs === 0,
			queuedJobs: this.pendingAttempts.size,
			stalledJobs,
		}
	}

	getAutomaticTranscriptionEnabled(): boolean {
		return this.database.getAutomaticTranscriptionEnabled()
	}

	getAutomaticTranscriptionSetting(): TranscriptionSettingStatus {
		return {
			automaticTranscription: this.database.getAutomaticTranscriptionEnabled(),
			cleanupPending: this.hasAutomaticCleanupPending(),
		}
	}

	async setAutomaticTranscriptionEnabled(
		enabled: boolean
	): Promise<TranscriptionSettingStatus> {
		this.database.setAutomaticTranscriptionEnabled(enabled)
		const previousTransition = this.automaticSettingTransition
		let finishTransition = (): void => undefined
		this.automaticSettingTransition = new Promise<void>((resolve) => {
			finishTransition = resolve
		})
		await previousTransition
		try {
			if (enabled) {
				await this.scanLocallyAvailableTorrents()
				return this.getAutomaticTranscriptionSetting()
			}
			const automaticJobs = this.database
				.listTranscriptionJobs()
				.filter(
					(job) => job.trigger === 'automatic' && ACTIVE_STATES.has(job.state)
				)
			try {
				await this.cancelJobs(automaticJobs, false, 'automatic_disabled')
			} catch (error) {
				if (
					!(
						error instanceof HttpError &&
						error.code === 'transcription_cleanup_pending'
					)
				) {
					throw error
				}
			}
			return this.getAutomaticTranscriptionSetting()
		} finally {
			finishTransition()
		}
	}

	async queueTorrent(
		infoHash: string,
		trigger: TranscriptionJobTrigger,
		signal?: AbortSignal
	): Promise<TranscriptionStatus[]> {
		assertRequestActive(signal)
		const normalized = this.assertLocallyAvailable(infoHash)
		const files = await this.torrentManager.cachedFiles(normalized)
		assertRequestActive(signal)
		const statuses: TranscriptionStatus[] = []
		for (const file of files) {
			if (!isTranscribableAudioFile(file)) {
				continue
			}
			let job: TranscriptionJobRecord | null
			try {
				job = this.queueFileRecord(normalized, file, trigger)
			} catch (error) {
				if (
					trigger === 'automatic' &&
					error instanceof HttpError &&
					error.code === 'transcription_cleanup_pending'
				) {
					continue
				}
				throw error
			}
			if (job) {
				statuses.push(this.toStatus(job))
			}
		}
		return statuses
	}

	async queueFile(
		infoHash: string,
		fileId: string,
		trigger: TranscriptionJobTrigger,
		signal?: AbortSignal
	): Promise<TranscriptionStatus> {
		assertRequestActive(signal)
		const normalized = normalizeInfoHash(infoHash)
		let file: TorrentFileDetails | undefined
		if (trigger === 'automatic') {
			this.assertLocallyAvailable(normalized)
			const files = await this.torrentManager.cachedFiles(normalized)
			file = files.find((candidate) => candidate.id === fileId)
		} else {
			file = await this.torrentManager.cachedFile(normalized, fileId, signal)
		}
		assertRequestActive(signal)
		if (!file) {
			throw new HttpError(404, 'file_not_found', 'Torrent file was not found')
		}
		if (!isTranscribableAudioFile(file)) {
			throw new HttpError(
				422,
				'file_not_audio',
				'The selected torrent file is not audio'
			)
		}
		const job = this.queueFileRecord(normalized, file, trigger)
		if (!job) {
			throw new HttpError(
				409,
				'automatic_transcription_disabled',
				'Automatic transcription was disabled before the job could be queued'
			)
		}
		return this.toStatus(job)
	}

	list(infoHash: string): TranscriptionStatus[] {
		const normalized = normalizeInfoHash(infoHash)
		return this.database
			.listTranscriptionJobs(normalized)
			.map((job) => this.toStatus(job))
	}

	get(infoHash: string, fileId: string): TranscriptionStatus | null {
		const job = this.findJob(infoHash, fileId)
		return job ? this.toStatus(job) : null
	}

	getArtifact(infoHash: string, fileId: string): CaptionArtifactRecord | null {
		const job = this.findJob(infoHash, fileId)
		if (!job) {
			return null
		}
		const artifact = this.database.getCaptionArtifact(
			job.infoHash,
			job.filePath
		)
		return artifact?.fileLength === job.fileLength ? artifact : null
	}

	async cancelFile(infoHash: string, fileId: string): Promise<boolean> {
		const job = this.findJob(infoHash, fileId)
		if (!job) {
			return false
		}
		await this.cancelJob(job, false)
		return true
	}

	async cancelTorrent(infoHash: string, purge: boolean): Promise<void> {
		const normalized = normalizeInfoHash(infoHash)
		if (this.cancellingTorrents.has(normalized)) {
			throw new HttpError(
				409,
				'transcription_cleanup_pending',
				'Transcription cancellation is still cleaning up local resources'
			)
		}
		this.cancellingTorrents.add(normalized)
		let releaseCancellation = true
		try {
			await this.cancelJobs(
				this.database.listTranscriptionJobs(normalized),
				purge
			)
		} catch (error) {
			if (this.hasActiveTorrent(normalized) && this.activePromise) {
				releaseCancellation = false
				this.activePromise.finally(() => {
					this.cancellingTorrents.delete(normalized)
				})
			}
			throw error
		} finally {
			if (releaseCancellation) {
				this.cancellingTorrents.delete(normalized)
			}
		}
	}

	private assertLocallyAvailable(infoHash: string): string {
		const normalized = normalizeInfoHash(infoHash)
		const summary = this.database.getTorrentStatusSummary(normalized)
		if (!summary) {
			throw new HttpError(404, 'torrent_not_found', 'Torrent was not found')
		}
		if (!(summary.metadataCompleted && summary.cacheCompleted)) {
			throw new HttpError(
				409,
				'audio_not_local',
				'The audiobook must finish downloading before transcription'
			)
		}
		return normalized
	}

	private queueFileRecord(
		infoHash: string,
		file: TorrentFileDetails,
		trigger: TranscriptionJobTrigger
	): TranscriptionJobRecord | null {
		if (this.state.closing) {
			throw new HttpError(
				503,
				'server_stopping',
				'Transcription service is stopping'
			)
		}
		if (this.torrentManager.isRemoving(infoHash)) {
			throw new HttpError(
				409,
				'torrent_removing',
				'Torrent removal is already in progress'
			)
		}
		const path = filePath(file)
		const key = jobKey(infoHash, path)
		const existing = this.database.getTranscriptionJob(infoHash, path)
		if (existing && ACTIVE_STATES.has(existing.state)) {
			return existing
		}
		if (this.cancellingTorrents.has(infoHash) || this.activeJobs.has(key)) {
			throw new HttpError(
				409,
				'transcription_cleanup_pending',
				'The previous transcription attempt is still cleaning up local resources'
			)
		}
		if (
			trigger === 'automatic' &&
			(existing?.state === 'failed' ||
				(existing?.state === 'cancelled' &&
					existing.errorCode !== 'automatic_disabled'))
		) {
			return existing
		}
		if (existing?.state === 'completed') {
			const artifact = this.database.getCaptionArtifactMetadata(infoHash, path)
			if (
				existing.fileId === file.id &&
				existing.fileLength === file.length &&
				existing.provider === this.provider.id &&
				existing.model === this.provider.model &&
				artifact?.fileLength === file.length &&
				artifact.formatVersion === CAPTION_FORMAT_VERSION &&
				artifact.provider === this.provider.id &&
				artifact.model === this.provider.model
			) {
				return existing
			}
		}
		if (
			trigger === 'automatic' &&
			!this.database.getAutomaticTranscriptionEnabled()
		) {
			return null
		}
		const timestamp = this.nextQueueTimestamp()
		const job: TranscriptionJobRecord = {
			attempt: (existing?.attempt ?? 0) + 1,
			createdAt: existing?.createdAt ?? timestamp,
			errorAmbiguous: false,
			errorCode: null,
			errorMessage: null,
			errorRetryable: false,
			fileId: file.id,
			fileLength: file.length,
			filePath: path,
			finishedAt: null,
			infoHash,
			model: this.provider.model,
			processedMilliseconds: 0,
			provider: this.provider.id,
			startedAt: null,
			state: 'queued',
			totalMilliseconds: null,
			trigger,
			updatedAt: timestamp,
		}
		this.database.putTranscriptionJob(job)
		this.enqueue(job)
		return job
	}

	private nextQueueTimestamp(): string {
		this.lastQueueTimestampMs = Math.max(
			Date.now(),
			this.lastQueueTimestampMs + 1
		)
		return new Date(this.lastQueueTimestampMs).toISOString()
	}

	private enqueue(job: TranscriptionJobRecord): void {
		const key = jobKey(job.infoHash, job.filePath)
		if (this.pendingAttempts.has(key) || this.activeJobs.has(key)) {
			return
		}
		this.pendingAttempts.set(key, job.attempt)
		this.pendingJobs.push({ attempt: job.attempt, key })
		queueMicrotask(() => {
			this.pump()
		})
	}

	private pump(): void {
		if (this.state.closing || this.activePromise || this.pumpSuspensions > 0) {
			return
		}
		const pending = this.pendingJobs.shift()
		if (!pending) {
			return
		}
		const { attempt, key } = pending
		if (this.pendingAttempts.get(key) !== attempt) {
			queueMicrotask(() => {
				this.pump()
			})
			return
		}
		this.pendingAttempts.delete(key)
		const separator = key.indexOf('\0')
		const infoHash = key.slice(0, separator)
		const path = key.slice(separator + 1)
		const job = this.database.getTranscriptionJob(infoHash, path)
		if (job?.state !== 'queued' || job.attempt !== attempt) {
			queueMicrotask(() => {
				this.pump()
			})
			return
		}
		const controller = new AbortController()
		const activeJob = { attempt, controller }
		this.activeJobs.set(key, activeJob)
		const promise = this.execute(job, controller.signal)
			.catch((error: unknown) => {
				this.logger.error('Unhandled transcription job failure', {
					error: asError(error).message,
					filePath: job.filePath,
					infoHash: job.infoHash,
				})
			})
			.finally(() => {
				if (this.purgeAfterCleanup.get(key) === attempt) {
					this.database.deleteTranscription(job.infoHash, job.filePath)
					this.purgeAfterCleanup.delete(key)
				}
				if (this.activeJobs.get(key) === activeJob) {
					this.activeJobs.delete(key)
				}
				this.clearWatchdogDeadline({ attempt, key })
				if (this.activePromise === promise) {
					this.activePromise = null
				}
				this.scheduleAutomaticRescan(job)
				this.pump()
			})
		this.activePromise = promise
	}

	private async execute(
		initialJob: TranscriptionJobRecord,
		cancellationSignal: AbortSignal
	): Promise<void> {
		const owner = {
			attempt: initialJob.attempt,
			key: jobKey(initialJob.infoHash, initialJob.filePath),
		}
		const operationController = new AbortController()
		const forwardCancellation = (): void => {
			operationController.abort(signalError(cancellationSignal))
		}
		if (cancellationSignal.aborted) {
			forwardCancellation()
		} else {
			cancellationSignal.addEventListener('abort', forwardCancellation, {
				once: true,
			})
		}
		const { signal } = operationController
		const watchdog = new ActivityWatchdog(
			this.config.requestTimeoutMs,
			(deadlineAt) => {
				if (deadlineAt) {
					this.setWatchdogDeadline(owner, deadlineAt)
				} else {
					this.clearWatchdogDeadline(owner)
				}
			},
			(error) => {
				operationController.abort(error)
			}
		)
		const cleanupDependencies = new Set<Promise<unknown>>()
		let openedFile:
			| Awaited<ReturnType<TorrentManager['openCachedFile']>>
			| undefined
		let opening:
			| Promise<Awaited<ReturnType<TorrentManager['openCachedFile']>>>
			| undefined
		let transcoding:
			| Promise<Awaited<ReturnType<AudioTranscoder['transcode']>>>
			| undefined
		let job: TranscriptionJobRecord = {
			...initialJob,
			startedAt: now(),
			state: 'preparing',
			updatedAt: now(),
		}
		if (!this.putOwnedJob(owner, job)) {
			cancellationSignal.removeEventListener('abort', forwardCancellation)
			return
		}
		try {
			watchdog.arm()
			opening = Promise.resolve().then(
				async () =>
					await this.torrentManager.openCachedFile(
						job.infoHash,
						job.fileId,
						signal
					)
			)
			openedFile = await raceWithSignal(opening, signal)
			if (!openedFile.stream) {
				throw new AudioPipelineError(
					'empty_audio',
					'The audiobook file contains no audio bytes.'
				)
			}
			const { localPath, stream } = openedFile
			this.assertJobOwned(owner, signal)
			job = { ...job, state: 'transcribing', updatedAt: now() }
			if (!this.putOwnedJob(owner, job)) {
				throw new JobOwnershipLostError()
			}
			watchdog.arm()
			const segmenter = new CaptionSegmenter()
			const detectedLanguages: string[] = []
			const stitcher = new WindowWordStitcher()
			transcoding = Promise.resolve().then(
				async () =>
					await this.transcoder.transcode(
						stream,
						signal,
						async (window) => {
							try {
								this.assertJobOwned(owner, signal)
								watchdog.pause()
								const transcription = await this.transcribeWindow(
									owner,
									window.wav,
									signal,
									cleanupDependencies
								)
								this.assertJobOwned(owner, signal)
								if (transcription.language) {
									detectedLanguages.push(transcription.language)
								}
								const shiftedWords = transcription.words.map((word) =>
									shiftedWord(word, window.inputStartMs)
								)
								for (const word of stitcher.pushWindow(
									shiftedWords,
									window.logicalEndMs
								)) {
									segmenter.push(word)
								}
								job = {
									...job,
									processedMilliseconds: window.logicalEndMs,
									updatedAt: now(),
								}
								if (!this.putOwnedJob(owner, job)) {
									throw new JobOwnershipLostError()
								}
								watchdog.arm()
							} catch (error) {
								operationController.abort(asError(error))
								throw error
							}
						},
						{ localPath }
					)
			)
			const result = await raceWithSignal(transcoding, signal)
			watchdog.pause()
			this.assertJobOwned(owner, signal)
			for (const word of stitcher.finish()) {
				segmenter.push(word)
			}
			const segments = clampSegmentsToDuration(
				segmenter.finish(),
				result.durationMs
			)
			const bytes = encodeCaptionTrack({
				durationMs: result.durationMs,
				segments,
			})
			const timestamp = now()
			const artifact: CaptionArtifactRecord = {
				bytes,
				createdAt: timestamp,
				cueCount: segments.length,
				durationMilliseconds: result.durationMs,
				fileLength: job.fileLength,
				filePath: job.filePath,
				formatVersion: CAPTION_FORMAT_VERSION,
				infoHash: job.infoHash,
				language: majorityLanguage(detectedLanguages) ?? null,
				model: job.model,
				provider: job.provider,
				sha256: createHash('sha256').update(bytes).digest('hex'),
				updatedAt: timestamp,
			}
			job = {
				...job,
				errorAmbiguous: false,
				errorCode: null,
				errorMessage: null,
				errorRetryable: false,
				finishedAt: timestamp,
				processedMilliseconds: result.durationMs,
				state: 'completed',
				totalMilliseconds: result.durationMs,
				updatedAt: timestamp,
			}
			this.assertJobOwned(owner, signal)
			this.database.completeTranscription(job, artifact)
			this.logger.info('Audiobook transcription completed', {
				captionBytes: bytes.byteLength,
				cueCount: segments.length,
				fileId: job.fileId,
				infoHash: job.infoHash,
			})
		} catch (value) {
			if (!signal.aborted) {
				operationController.abort(
					value instanceof Error ? value : new Error('Transcription failed')
				)
			}
			this.persistExecutionFailure(owner, job, value, cancellationSignal)
		} finally {
			if (!signal.aborted) {
				operationController.abort(abortError())
			}
			await this.cleanupExecution(
				opening,
				openedFile,
				transcoding,
				cleanupDependencies,
				job
			)
			watchdog.pause()
			cancellationSignal.removeEventListener('abort', forwardCancellation)
		}
	}

	private async cleanupExecution(
		opening:
			| Promise<Awaited<ReturnType<TorrentManager['openCachedFile']>>>
			| undefined,
		openedFile:
			| Awaited<ReturnType<TorrentManager['openCachedFile']>>
			| undefined,
		transcoding:
			| Promise<Awaited<ReturnType<AudioTranscoder['transcode']>>>
			| undefined,
		cleanupDependencies: ReadonlySet<Promise<unknown>>,
		job: Pick<TranscriptionJobRecord, 'fileId' | 'infoHash'>
	): Promise<void> {
		let ownedFile = openedFile
		if (opening && !ownedFile) {
			try {
				ownedFile = await opening
			} catch {
				// Opening failed without transferring ownership of a stream lease.
			}
		}
		if (transcoding) {
			try {
				await transcoding
			} catch {
				// The primary failure was already persisted by execute.
			}
		}
		if (ownedFile?.stream) {
			await this.finalizeStream(ownedFile.stream, ownedFile.released, job)
		}
		for (const dependency of cleanupDependencies) {
			try {
				// biome-ignore lint/performance/noAwaitInLoops: Cleanup ownership must remain serialized with its job.
				await dependency
			} catch {
				// Provider failures are represented by the persisted job failure.
			}
		}
	}

	private persistExecutionFailure(
		owner: JobOwner,
		job: TranscriptionJobRecord,
		value: unknown,
		cancellationSignal: AbortSignal
	): void {
		const timestamp = now()
		const failure = this.terminalFailure(value, cancellationSignal)
		const failedJob: TranscriptionJobRecord = {
			...job,
			errorAmbiguous: failure.error.ambiguous,
			errorCode: failure.error.code,
			errorMessage: failure.error.message,
			errorRetryable: failure.error.retryable,
			finishedAt: timestamp,
			state: failure.state,
			updatedAt: timestamp,
		}
		const persisted = this.putOwnedJob(owner, failedJob)
		if (
			persisted &&
			failure.state === 'failed' &&
			!(
				isAbortError(value) ||
				value instanceof JobOwnershipLostError ||
				this.state.closing
			)
		) {
			this.logger.warn('Audiobook transcription failed', {
				errorCode: failure.error.code,
				fileId: failedJob.fileId,
				infoHash: failedJob.infoHash,
			})
		}
	}

	private assertJobOwned(owner: JobOwner, signal: AbortSignal): void {
		if (signal.aborted) {
			throw signalError(signal)
		}
		if (!this.isJobOwned(owner)) {
			throw new JobOwnershipLostError()
		}
	}

	private clearWatchdogDeadline(owner: JobOwner): void {
		const current = this.watchdogDeadlines.get(owner.key)
		if (current?.attempt === owner.attempt) {
			this.watchdogDeadlines.delete(owner.key)
		}
	}

	private async finalizeStream(
		stream: ReadableStream<Uint8Array>,
		released: Promise<void> | undefined,
		job: Pick<TranscriptionJobRecord, 'fileId' | 'infoHash'>
	): Promise<void> {
		try {
			await stream.cancel()
		} catch (error) {
			this.logger.warn('Unable to finalize transcription audio stream', {
				error: asError(error).message,
				fileId: job.fileId,
				infoHash: job.infoHash,
			})
		}
		if (released) {
			await released
		}
	}

	private isJobOwned(owner: JobOwner): boolean {
		const separator = owner.key.indexOf('\0')
		const job = this.database.getTranscriptionJob(
			owner.key.slice(0, separator),
			owner.key.slice(separator + 1)
		)
		return Boolean(
			job && job.attempt === owner.attempt && ACTIVE_STATES.has(job.state)
		)
	}

	private putOwnedJob(owner: JobOwner, job: TranscriptionJobRecord): boolean {
		if (!this.isJobOwned(owner)) {
			return false
		}
		this.database.putTranscriptionJob(job)
		return true
	}

	private setWatchdogDeadline(owner: JobOwner, deadlineAt: string): void {
		const active = this.activeJobs.get(owner.key)
		if (active?.attempt === owner.attempt) {
			this.watchdogDeadlines.set(owner.key, {
				attempt: owner.attempt,
				deadlineAt,
			})
		}
	}

	private async transcribeWindow(
		owner: JobOwner,
		wav: Uint8Array,
		signal: AbortSignal,
		cleanupDependencies: Set<Promise<unknown>>
	): Promise<Awaited<ReturnType<SpeechProvider['transcribe']>>> {
		const controller = new AbortController()
		const forwardAbort = (): void => {
			controller.abort(signalError(signal))
		}
		if (signal.aborted) {
			forwardAbort()
		} else {
			signal.addEventListener('abort', forwardAbort, { once: true })
		}
		const providerTimeout = new SpeechProviderFailure(
			'timeout',
			'The speech transcription request timed out and may have completed.',
			{ ambiguous: true, retryable: true }
		)
		const deadlineAt = new Date(
			Date.now() + this.config.requestTimeoutMs
		).toISOString()
		this.setWatchdogDeadline(owner, deadlineAt)
		const timeout = setTimeout(() => {
			controller.abort(providerTimeout)
		}, this.config.requestTimeoutMs)
		const transcription = Promise.resolve().then(
			async () =>
				await this.provider.transcribe(wav, {
					signal: controller.signal,
					timeoutMs: this.config.requestTimeoutMs,
				})
		)
		try {
			return await raceWithSignal(transcription, controller.signal)
		} catch (error) {
			if (controller.signal.aborted) {
				this.provider.reset?.()
				cleanupDependencies.add(transcription)
			}
			throw error
		} finally {
			clearTimeout(timeout)
			this.clearWatchdogDeadline(owner)
			signal.removeEventListener('abort', forwardAbort)
		}
	}

	private failure(value: unknown): TranscriptionErrorSummary {
		if (value instanceof TranscriptionStalledError) {
			return {
				ambiguous: false,
				code: 'transcription_stalled',
				message: value.message,
				retryable: true,
			}
		}
		if (value instanceof SpeechProviderFailure) {
			return {
				ambiguous: value.ambiguous,
				code: value.code,
				message: value.message,
				retryable: value.retryable,
			}
		}
		if (value instanceof AudioPipelineError) {
			return {
				ambiguous: false,
				code: value.code,
				message: value.message,
				retryable: false,
			}
		}
		if (value instanceof HttpError) {
			return {
				ambiguous: false,
				code: value.code,
				message: value.message,
				retryable: value.code === 'audio_not_local' || value.status >= 500,
			}
		}
		if (isAbortError(value)) {
			return {
				ambiguous: false,
				code: 'cancelled',
				message: 'Transcription was cancelled.',
				retryable: true,
			}
		}
		return {
			ambiguous: false,
			code: 'transcription_failed',
			message: 'The server could not complete the transcription.',
			retryable: true,
		}
	}

	private terminalFailure(
		value: unknown,
		signal: AbortSignal
	): TerminalJobFailure {
		if (this.state.closing) {
			return {
				error: {
					ambiguous: true,
					code: 'server_interrupted',
					message:
						'Transcription was interrupted and requires an explicit retry.',
					retryable: true,
				},
				state: 'failed',
			}
		}
		if (signal.aborted) {
			return {
				error: {
					ambiguous: false,
					code: 'cancelled',
					message: 'Transcription was cancelled.',
					retryable: true,
				},
				state: 'cancelled',
			}
		}
		return { error: this.failure(value), state: 'failed' }
	}

	private findJob(
		infoHash: string,
		fileId: string
	): TranscriptionJobRecord | null {
		const normalized = normalizeInfoHash(infoHash)
		return (
			this.database
				.listTranscriptionJobs(normalized)
				.find((job) => job.fileId === fileId) ?? null
		)
	}

	private toStatus(job: TranscriptionJobRecord): TranscriptionStatus {
		const storedArtifact = this.database.getCaptionArtifactMetadata(
			job.infoHash,
			job.filePath
		)
		const artifact =
			storedArtifact?.fileLength === job.fileLength ? storedArtifact : null
		const queue = this.queueDetails(job)
		const deadline = this.watchdogDeadlines.get(
			jobKey(job.infoHash, job.filePath)
		)
		const active = this.activeJobs.get(jobKey(job.infoHash, job.filePath))
		const cleanupPending =
			active?.attempt === job.attempt && !ACTIVE_STATES.has(job.state)
		const queueBlockedByCleanup =
			job.state === 'queued' && this.hasPhysicalCleanupOwner()
		const activeDeadline =
			deadline?.attempt === job.attempt &&
			(job.state === 'preparing' || job.state === 'transcribing')
				? deadline
				: null
		return {
			attempt: job.attempt,
			...(artifact
				? {
						captions: {
							byteLength: artifact.byteLength,
							cueCount: artifact.cueCount,
							durationMilliseconds: artifact.durationMilliseconds,
							etag: artifactEtag(artifact),
							formatVersion: artifact.formatVersion,
							...(artifact.language ? { language: artifact.language } : {}),
							updatedAt: artifact.updatedAt,
							url: captionsUrl(job),
						},
					}
				: {}),
			createdAt: job.createdAt,
			...(cleanupPending ? { cleanupPending: true } : {}),
			...(job.errorCode && job.errorMessage
				? {
						error: {
							ambiguous: job.errorAmbiguous,
							code: job.errorCode,
							message: job.errorMessage,
							retryable: job.errorRetryable,
						},
					}
				: {}),
			fileId: job.fileId,
			fileLength: job.fileLength,
			...(job.finishedAt ? { finishedAt: job.finishedAt } : {}),
			infoHash: job.infoHash,
			path: job.filePath.split('/').filter(Boolean),
			processedMilliseconds: job.processedMilliseconds,
			...(queueBlockedByCleanup ? { queueBlockedByCleanup: true } : {}),
			...(queue ?? {}),
			...(job.startedAt ? { startedAt: job.startedAt } : {}),
			state: job.state,
			...(job.totalMilliseconds === null
				? {}
				: { totalMilliseconds: job.totalMilliseconds }),
			trigger: job.trigger,
			updatedAt: job.updatedAt,
			...(activeDeadline
				? {
						watchdogDeadlineAt: activeDeadline.deadlineAt,
						watchdogRemainingMilliseconds: Math.max(
							0,
							Date.parse(activeDeadline.deadlineAt) - Date.now()
						),
					}
				: {}),
		}
	}

	private hasPhysicalCleanupOwner(): boolean {
		for (const [key, active] of this.activeJobs) {
			const separator = key.indexOf('\0')
			const job = this.database.getTranscriptionJob(
				key.slice(0, separator),
				key.slice(separator + 1)
			)
			if (
				!(job && job.attempt === active.attempt && ACTIVE_STATES.has(job.state))
			) {
				return true
			}
		}
		return false
	}

	private queueDetails(
		job: TranscriptionJobRecord
	): Pick<TranscriptionStatus, 'queuedAhead' | 'queuePosition'> | null {
		const targetKey = jobKey(job.infoHash, job.filePath)
		const active = this.activeJobs.get(targetKey)
		if (
			active?.attempt === job.attempt &&
			(job.state === 'preparing' || job.state === 'transcribing')
		) {
			return { queuedAhead: 0, queuePosition: 1 }
		}
		if (job.state !== 'queued') {
			return null
		}
		let validPendingAhead = 0
		for (const pending of this.pendingJobs) {
			if (this.pendingAttempts.get(pending.key) !== pending.attempt) {
				continue
			}
			if (pending.key === targetKey && pending.attempt === job.attempt) {
				const queuedAhead = this.activeJobs.size + validPendingAhead
				return { queuedAhead, queuePosition: queuedAhead + 1 }
			}
			validPendingAhead += 1
		}
		return null
	}

	private async cancelJob(
		job: TranscriptionJobRecord,
		purge: boolean,
		errorCode: 'automatic_disabled' | 'cancelled' = 'cancelled'
	): Promise<void> {
		await this.cancelJobs([job], purge, errorCode)
	}

	private async cancelJobs(
		jobs: readonly TranscriptionJobRecord[],
		purge: boolean,
		errorCode: 'automatic_disabled' | 'cancelled' = 'cancelled'
	): Promise<void> {
		if (jobs.length === 0) {
			return
		}
		this.pumpSuspensions += 1
		let activeCleanup: Promise<void> | null = null
		try {
			for (const job of jobs) {
				const cleanup = this.cancelJobRecord(job, purge, errorCode)
				activeCleanup ??= cleanup
			}
			this.compactPendingJobs()
			if (activeCleanup) {
				await this.confirmCleanup(activeCleanup)
			}
		} finally {
			this.pumpSuspensions -= 1
			this.pump()
		}
	}

	private cancelJobRecord(
		job: TranscriptionJobRecord,
		purge: boolean,
		errorCode: 'automatic_disabled' | 'cancelled'
	): Promise<void> | null {
		const key = jobKey(job.infoHash, job.filePath)
		if (this.pendingAttempts.get(key) === job.attempt) {
			this.pendingAttempts.delete(key)
		}
		const active = this.activeJobs.get(key)
		if (active?.attempt === job.attempt) {
			if (purge) {
				this.purgeAfterCleanup.set(key, job.attempt)
			}
			if (ACTIVE_STATES.has(job.state)) {
				this.putCancelledJob(job, key, errorCode)
			}
			active.controller.abort(abortError())
			return this.activePromise
		}
		if (purge) {
			this.database.deleteTranscription(job.infoHash, job.filePath)
		} else if (ACTIVE_STATES.has(job.state)) {
			this.putCancelledJob(job, key, errorCode)
		}
		return null
	}

	private putCancelledJob(
		job: TranscriptionJobRecord,
		key: string,
		errorCode: 'automatic_disabled' | 'cancelled'
	): void {
		this.putOwnedJob(
			{ attempt: job.attempt, key },
			{
				...job,
				errorAmbiguous: false,
				errorCode,
				errorMessage:
					errorCode === 'automatic_disabled'
						? 'Automatic transcription was disabled.'
						: 'Transcription was cancelled.',
				errorRetryable: true,
				finishedAt: now(),
				state: 'cancelled',
				updatedAt: now(),
			}
		)
	}

	private compactPendingJobs(): void {
		let retained = 0
		for (const pending of this.pendingJobs) {
			if (this.pendingAttempts.get(pending.key) !== pending.attempt) {
				continue
			}
			this.pendingJobs[retained] = pending
			retained += 1
		}
		this.pendingJobs.length = retained
	}

	private async confirmCleanup(cleanup: Promise<void>): Promise<void> {
		const timeoutMs = Math.min(
			this.config.requestTimeoutMs,
			MAXIMUM_CANCELLATION_CONFIRMATION_MS
		)
		let timeout: ReturnType<typeof setTimeout> | null = null
		const confirmed = await Promise.race([
			cleanup.then(() => true),
			new Promise<false>((resolve) => {
				timeout = setTimeout(() => resolve(false), timeoutMs)
			}),
		])
		if (timeout !== null) {
			clearTimeout(timeout)
		}
		if (!confirmed) {
			throw new HttpError(
				503,
				'transcription_cleanup_pending',
				'Transcription was cancelled, but local process cleanup is still in progress'
			)
		}
	}

	private hasActiveTorrent(infoHash: string): boolean {
		const prefix = `${infoHash}\0`
		return [...this.activeJobs.keys()].some((key) => key.startsWith(prefix))
	}

	private hasAutomaticCleanupPending(): boolean {
		for (const [key, active] of this.activeJobs) {
			const separator = key.indexOf('\0')
			const job = this.database.getTranscriptionJob(
				key.slice(0, separator),
				key.slice(separator + 1)
			)
			if (
				job?.attempt === active.attempt &&
				job.state === 'cancelled' &&
				job.errorCode === 'automatic_disabled'
			) {
				return true
			}
		}
		return false
	}

	private scheduleAutomaticRescan(
		finishedJob: Pick<
			TranscriptionJobRecord,
			'attempt' | 'filePath' | 'infoHash'
		>
	): void {
		if (
			this.state.closing ||
			!this.database.getAutomaticTranscriptionEnabled()
		) {
			return
		}
		const current = this.database.getTranscriptionJob(
			finishedJob.infoHash,
			finishedJob.filePath
		)
		if (
			current?.attempt !== finishedJob.attempt ||
			current.state !== 'cancelled' ||
			current.errorCode !== 'automatic_disabled' ||
			this.automaticRescans.has(finishedJob.infoHash)
		) {
			return
		}
		this.automaticRescans.add(finishedJob.infoHash)
		queueMicrotask(() => {
			this.queueTorrent(finishedJob.infoHash, 'automatic')
				.catch((error: unknown) => {
					this.logger.warn(
						'Unable to resume automatic transcription after cleanup',
						{
							error: asError(error).message,
							infoHash: finishedJob.infoHash,
						}
					)
				})
				.finally(() => {
					this.automaticRescans.delete(finishedJob.infoHash)
				})
		})
	}

	private async scanLocallyAvailableTorrents(): Promise<void> {
		for (const infoHash of this.database.listLocallyAvailableTorrentHashes()) {
			try {
				// biome-ignore lint/performance/noAwaitInLoops: The scan is intentionally sequential to bound torrent sessions.
				await this.queueTorrent(infoHash, 'automatic')
			} catch (error) {
				this.logger.warn('Unable to inspect local audiobook for captions', {
					error: asError(error).message,
					infoHash,
				})
			}
		}
	}
}

export { artifactEtag }

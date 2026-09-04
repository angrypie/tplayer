import { decodeCaptionTrack } from '@tplayer/captions/codec'
import { createCaptionLookup } from '@tplayer/captions/lookup'
import type { BookStorage, StoredCaptionTrack } from '~/storage'
import {
	type CaptionApiClient,
	CaptionApiError,
	type CompletedCaptionMetadata,
	captionApi,
	type TranscriptionStatus,
} from './api'

const DEFAULT_POLL_INTERVAL_MS = 1500
const DEFAULT_STALL_AFTER_MS = 15 * 60 * 1000
const DEFAULT_SERVICE_REQUEST_TIMEOUT_MS = 15_000

export interface CaptionTarget {
	fileId: string
	fileLength: number
	infoHash: string
	path: readonly string[]
}

export type CaptionSessionPhase =
	| 'cancelled'
	| 'cancelling'
	| 'cleaning'
	| 'failed'
	| 'idle'
	| 'loading'
	| 'preparing'
	| 'queued'
	| 'ready'
	| 'transcribing'
	| 'unavailable'

export interface CaptionActionError {
	code: string
	message: string
	retryable: boolean
	status: number
}

export interface CaptionSessionSnapshot {
	actionError?: CaptionActionError
	cached: boolean
	connectionIssue?: CaptionConnectionIssue
	message?: string
	phase: CaptionSessionPhase
	status: TranscriptionStatus | null
}

export interface CaptionConnectionIssue {
	consecutiveFailures: number
	detectedAt: string
	kind: 'stalled' | 'unreachable'
	lastReachedAt?: string
}

interface CaptionRepository {
	getCaptionTrack: BookStorage['getCaptionTrack']
	putCaptionTrack: BookStorage['putCaptionTrack']
	removeCaptionTrack: BookStorage['removeCaptionTrack']
}

export type CaptionService = Pick<
	CaptionApiClient,
	'cancel' | 'getStatus' | 'getTrack' | 'start'
>

interface CaptionSessionOptions {
	api?: CaptionService
	elapsedNow?: () => number
	now?: () => number
	pollIntervalMs?: number
	repository: CaptionRepository
	serviceRequestTimeoutMs?: number
	stallAfterMs?: number
}

type DecodedTrack = ReturnType<typeof decodeCaptionTrack>
type CaptionLookup = ReturnType<typeof createCaptionLookup>
type Listener = () => void
type CaptionSessionState = Omit<CaptionSessionSnapshot, 'connectionIssue'>
type ServiceOperation = 'cancel' | 'start' | 'status' | 'track'
type DeferredStartIntent = 'restart' | 'retry'

interface RunningObservation {
	attempt: number
	fileId: string
	observedAt: number
	processedMilliseconds: number
	state: 'preparing' | 'transcribing'
	unchangedPolls: number
	updatedAt: string
}

const serviceCallRegistries = new WeakMap<
	CaptionService,
	Map<ServiceOperation, Promise<unknown>>
>()

const serviceCallRegistry = (
	service: CaptionService
): Map<ServiceOperation, Promise<unknown>> => {
	const existing = serviceCallRegistries.get(service)
	if (existing) {
		return existing
	}
	const created = new Map<ServiceOperation, Promise<unknown>>()
	serviceCallRegistries.set(service, created)
	return created
}

const idleSnapshot = (): CaptionSessionSnapshot => ({
	cached: false,
	phase: 'idle',
	status: null,
})

const pathKey = (path: readonly string[]): string => path.join('/')

const artifactRevisionTime = (updatedAt: string | undefined): number => {
	const parsed = updatedAt ? Date.parse(updatedAt) : Number.NaN
	return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY
}

const storedTrackCanSatisfy = (
	stored: StoredCaptionTrack,
	target: CaptionTarget,
	metadata: CompletedCaptionMetadata
): boolean => {
	if (stored.fileLength !== target.fileLength) {
		return false
	}
	if (stored.etag === metadata.etag) {
		return true
	}
	return (
		stored.artifactUpdatedAt !== undefined &&
		Date.parse(stored.artifactUpdatedAt) > Date.parse(metadata.updatedAt)
	)
}

const storedTrackNeedsRevisionPromotion = (
	stored: StoredCaptionTrack,
	etag: string,
	artifactUpdatedAt: string
): boolean =>
	stored.etag === etag &&
	artifactRevisionTime(stored.artifactUpdatedAt) <
		artifactRevisionTime(artifactUpdatedAt)

const errorMessage = (error: unknown): string =>
	error instanceof Error ? error.message : 'Unable to load live captions'

const isAbortError = (error: unknown): boolean =>
	error instanceof Error && error.name === 'AbortError'

const isDefinitiveApiError = (error: unknown): error is CaptionApiError =>
	error instanceof CaptionApiError

const actionErrorMetadata = (error: CaptionApiError): CaptionActionError => ({
	code: error.code,
	message: error.message,
	retryable:
		error.status === 408 ||
		error.status === 425 ||
		error.status === 429 ||
		error.status >= 500,
	status: error.status,
})

const isCleanupPendingError = (error: unknown): error is CaptionApiError =>
	error instanceof CaptionApiError &&
	error.code === 'transcription_cleanup_pending'

const isAudioNotLocalError = (error: unknown): error is CaptionApiError =>
	error instanceof CaptionApiError && error.code === 'audio_not_local'

const isCaptionTransportError = (error: unknown): boolean =>
	error instanceof CaptionServiceTimeoutError ||
	error instanceof CaptionServiceBusyError ||
	error instanceof TypeError

const abortError = (): Error => {
	const error = new Error('Caption service request was cancelled')
	error.name = 'AbortError'
	return error
}

class CaptionServiceTimeoutError extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'CaptionServiceTimeoutError'
	}
}

class CaptionServiceBusyError extends Error {
	constructor(operation: ServiceOperation) {
		super(
			`An earlier ${operation} request is still stopping. TPlayer will wait before trying again.`
		)
		this.name = 'CaptionServiceBusyError'
	}
}

const runningPhase = (
	status: TranscriptionStatus
): Extract<CaptionSessionPhase, 'preparing' | 'queued' | 'transcribing'> => {
	if (status.state === 'preparing') {
		return 'preparing'
	}
	if (status.state === 'transcribing') {
		return 'transcribing'
	}
	return 'queued'
}

const statusIsRunning = (status: TranscriptionStatus | null): boolean =>
	status?.state === 'queued' ||
	status?.state === 'preparing' ||
	status?.state === 'transcribing'

const asCancelledStatus = (
	status: TranscriptionStatus | null
): TranscriptionStatus | null => {
	if (!status) {
		return null
	}
	const timestamp = new Date().toISOString()
	const cancelledStatus = { ...status }
	Reflect.deleteProperty(cancelledStatus, 'cleanupPending')
	return {
		...cancelledStatus,
		error: {
			ambiguous: false,
			code: 'cancelled',
			message: 'Transcription was cancelled.',
			retryable: true,
		},
		finishedAt: timestamp,
		state: 'cancelled',
		updatedAt: timestamp,
	}
}

export class CaptionSession {
	private abortController: AbortController | null = null
	private readonly api: CaptionService
	private readonly elapsedNow: () => number
	private readonly listeners = new Set<Listener>()
	private lookup: CaptionLookup | null = null
	private connectionIssue: CaptionConnectionIssue | undefined
	private deferredStart: DeferredStartIntent | null = null
	private lastReachedAt: string | undefined
	private readonly now: () => number
	private readonly pollIntervalMs: number
	private pollFailureCount = 0
	private pollTimer: ReturnType<typeof setTimeout> | null = null
	private readonly repository: CaptionRepository
	private revision = 0
	private runningObservation: RunningObservation | null = null
	private readonly serviceRequestTimeoutMs: number
	private readonly serviceCalls: Map<ServiceOperation, Promise<unknown>>
	private readonly stallAfterMs: number
	private snapshot: CaptionSessionSnapshot = idleSnapshot()
	private target: CaptionTarget | null = null
	private track: DecodedTrack | null = null
	private trackEtag: string | null = null
	private waitingForServerAudio: CaptionActionError | null = null

	constructor({
		api = captionApi,
		elapsedNow = () => globalThis.performance?.now() ?? Date.now(),
		now = Date.now,
		pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
		repository,
		serviceRequestTimeoutMs = DEFAULT_SERVICE_REQUEST_TIMEOUT_MS,
		stallAfterMs = DEFAULT_STALL_AFTER_MS,
	}: CaptionSessionOptions) {
		this.api = api
		this.elapsedNow = elapsedNow
		this.now = now
		this.repository = repository
		this.serviceCalls = serviceCallRegistry(api)
		this.pollIntervalMs = Math.max(50, pollIntervalMs)
		this.serviceRequestTimeoutMs = Math.max(100, serviceRequestTimeoutMs)
		this.stallAfterMs = Math.max(this.pollIntervalMs, stallAfterMs)
	}

	getSnapshot = (): CaptionSessionSnapshot => this.snapshot

	subscribe = (listener: Listener): (() => void) => {
		this.listeners.add(listener)
		return () => {
			this.listeners.delete(listener)
		}
	}

	async activate(
		target: CaptionTarget | null,
		allowServer: boolean
	): Promise<void> {
		const revision = this.beginRequest(target)
		if (!target) {
			this.publish(idleSnapshot())
			this.finishRequest(revision)
			return
		}

		this.publish({ cached: false, phase: 'loading', status: null })
		const cached = await this.loadCached(target, revision)
		if (!this.isCurrent(revision)) {
			return
		}
		if (!allowServer) {
			if (!cached) {
				this.publish({
					cached: false,
					message: 'Captions are not saved on this device.',
					phase: 'unavailable',
					status: null,
				})
			}
			this.finishRequest(revision)
			return
		}

		await this.synchronize(revision, cached)
	}

	async checkStatus(): Promise<void> {
		const target = this.currentTarget()
		if (!target) {
			return
		}
		const previousStatus = this.snapshot.status
		const isCached = this.snapshot.cached
		const revision = this.beginRequest(target, false)
		this.publish(
			this.track
				? {
						cached: isCached,
						message: 'Checking transcription status…',
						phase: 'ready',
						status: previousStatus,
					}
				: {
						cached: false,
						message: 'Checking transcription status…',
						phase:
							previousStatus && statusIsRunning(previousStatus)
								? runningPhase(previousStatus)
								: 'loading',
						status: previousStatus,
					}
		)
		let status: TranscriptionStatus | null
		try {
			status = await this.requestStatus(target)
		} catch (error) {
			this.handleStatusRequestError(error, revision, isCached, previousStatus)
			return
		}
		if (!this.isCurrent(revision)) {
			return
		}
		if (!status) {
			this.applyMissingStatus(revision, isCached)
			return
		}
		await this.applyStatusSafely(status, revision, isCached)
	}

	async retry(): Promise<void> {
		const target = this.currentTarget()
		if (!target) {
			return
		}
		const trackAvailable = this.track !== null
		const isCached = this.snapshot.cached
		const previousStatus = this.snapshot.status
		const revision = this.beginRequest(target, false)
		this.deferredStart = null
		this.publish(
			trackAvailable
				? {
						cached: isCached,
						message: isCached
							? 'Refreshing saved captions…'
							: 'Refreshing captions that are not saved offline…',
						phase: 'ready',
						status: null,
					}
				: {
						cached: false,
						phase: 'loading',
						status: this.snapshot.status,
					}
		)
		try {
			const status = await this.startTranscription(target)
			if (this.isCurrent(revision)) {
				await this.applyStatusSafely(status, revision, isCached)
			}
		} catch (error) {
			if (isCleanupPendingError(error)) {
				this.deferredStart = 'retry'
				await this.observeDeferredCleanup(
					target,
					previousStatus,
					revision,
					isCached
				)
				return
			}
			if (!isDefinitiveApiError(error)) {
				this.publishStatusUnavailable(error, revision, isCached, previousStatus)
				this.schedulePoll(revision, this.snapshot.cached, true)
				return
			}
			this.publishErrorIfCurrent(error, revision, isCached, previousStatus)
			if (isAudioNotLocalError(error)) {
				this.waitingForServerAudio = actionErrorMetadata(error)
				this.schedulePoll(revision, isCached)
				return
			}
			this.finishRequest(revision)
		}
	}

	async restart(): Promise<void> {
		const target = this.currentTarget()
		if (!target) {
			return
		}
		const previousStatus = this.snapshot.status
		const isCached = this.snapshot.cached
		const revision = this.beginRequest(target, false)
		this.deferredStart = null
		this.publish(
			this.track
				? {
						cached: isCached,
						message: 'Restarting transcription…',
						phase: 'ready',
						status: previousStatus,
					}
				: {
						cached: false,
						message: 'Restarting transcription…',
						phase: 'loading',
						status: previousStatus,
					}
		)
		try {
			await this.cancelTranscription(target)
		} catch (error) {
			if (isCleanupPendingError(error)) {
				this.deferredStart = 'restart'
				await this.observeDeferredCleanup(
					target,
					previousStatus,
					revision,
					isCached
				)
				return
			}
			if (isDefinitiveApiError(error)) {
				this.publishActionRejection(
					`Transcription could not be cancelled, so it was not restarted. ${error.message}`,
					revision,
					isCached,
					previousStatus,
					error
				)
				this.schedulePoll(revision, isCached, true)
				return
			}
			this.publishStatusUnavailable(error, revision, isCached, previousStatus)
			this.schedulePoll(revision, isCached, true)
			return
		}
		if (!this.isCurrent(revision)) {
			return
		}
		try {
			const status = await this.startTranscription(target)
			if (this.isCurrent(revision)) {
				await this.applyStatusSafely(status, revision, isCached)
			}
		} catch (error) {
			if (!isDefinitiveApiError(error)) {
				this.publishStatusUnavailable(
					error,
					revision,
					isCached,
					asCancelledStatus(previousStatus)
				)
				this.schedulePoll(revision, this.snapshot.cached, true)
				return
			}
			this.publishRestartFailure(error, revision, isCached, previousStatus)
			if (isAudioNotLocalError(error)) {
				this.waitingForServerAudio = actionErrorMetadata(error)
				this.schedulePoll(revision, isCached)
				return
			}
			this.finishRequest(revision)
		}
	}

	async cancel(): Promise<void> {
		const target = this.currentTarget()
		if (!target) {
			return
		}
		const previousStatus = this.snapshot.status
		const trackAvailable = this.track !== null
		const isCached = this.snapshot.cached
		const revision = this.beginRequest(target, false)
		this.deferredStart = null
		this.publish(
			trackAvailable
				? {
						cached: isCached,
						message: isCached
							? 'Saved captions are shown while the refresh is being cancelled…'
							: 'Captions remain visible while the refresh is being cancelled; they are not saved offline.',
						phase: 'ready',
						status: null,
					}
				: {
						cached: false,
						phase: 'cancelling',
						status: previousStatus,
					}
		)
		try {
			await this.cancelTranscription(target)
		} catch (error) {
			if (isCleanupPendingError(error)) {
				await this.verifyCancellation(
					target,
					previousStatus,
					revision,
					isCached
				)
				return
			}
			if (isDefinitiveApiError(error)) {
				this.publishActionRejection(
					`Cancellation was rejected by the server. ${error.message}`,
					revision,
					isCached,
					previousStatus,
					error
				)
				this.schedulePoll(revision, isCached, true)
				return
			}
			this.publishStatusUnavailable(error, revision, isCached, previousStatus)
			this.schedulePoll(revision, isCached, true)
			return
		}
		if (!this.isCurrent(revision)) {
			return
		}
		await this.verifyCancellation(target, previousStatus, revision, isCached)
	}

	private async verifyCancellation(
		target: CaptionTarget,
		previousStatus: TranscriptionStatus | null,
		revision: number,
		isCached: boolean
	): Promise<void> {
		let status: TranscriptionStatus | null
		try {
			status = await this.requestStatus(target)
		} catch (error) {
			this.handleCancellationVerificationError(
				error,
				previousStatus,
				revision,
				isCached
			)
			return
		}
		if (!this.isCurrent(revision)) {
			return
		}
		if (status) {
			await this.applyStatusSafely(status, revision, isCached)
			return
		}
		const cancelledStatus = asCancelledStatus(previousStatus)
		if (cancelledStatus) {
			await this.applyStatus(cancelledStatus, revision, isCached)
			return
		}
		if (this.track) {
			this.publish({
				cached: isCached,
				...(isCached
					? {}
					: {
							message:
								'Captions remain available for this session but are not saved offline.',
						}),
				phase: 'ready',
				status: null,
			})
			this.finishRequest(revision)
			return
		}
		this.publish({
			cached: false,
			message: 'Transcription was cancelled.',
			phase: 'cancelled',
			status: null,
		})
		this.finishRequest(revision)
	}

	private handleCancellationVerificationError(
		error: unknown,
		previousStatus: TranscriptionStatus | null,
		revision: number,
		isCached: boolean
	): void {
		if (!(this.isCurrent(revision) && !isAbortError(error))) {
			return
		}
		this.pollFailureCount += 1
		if (isDefinitiveApiError(error)) {
			this.connectionIssue = undefined
		} else {
			this.noteUnreachable()
		}
		this.publishUnverifiedCancellation(
			previousStatus,
			isCached,
			isDefinitiveApiError(error) ? error.message : undefined
		)
		this.schedulePoll(revision, isCached, true)
	}

	seek(timeMilliseconds: number): number {
		if (!this.lookup) {
			return -1
		}
		this.lookup.seek(Math.max(0, Math.trunc(timeMilliseconds)))
		return this.lookup.index
	}

	textAt(index: number): string {
		if (!(this.track && index >= 0 && index < this.track.segmentCount)) {
			return ''
		}
		return this.track.textAt(index)
	}

	get segmentCount(): number {
		return this.track?.segmentCount ?? 0
	}

	dispose(): void {
		this.revision += 1
		this.abortPending()
		this.target = null
		this.track = null
		this.trackEtag = null
		this.lookup = null
		this.deferredStart = null
		this.runningObservation = null
		this.waitingForServerAudio = null
		this.listeners.clear()
		this.snapshot = idleSnapshot()
	}

	private beginRequest(
		target: CaptionTarget | null,
		clearTrack = true
	): number {
		this.revision += 1
		this.abortPending()
		this.abortController = new AbortController()
		this.connectionIssue = undefined
		this.waitingForServerAudio = null
		if (clearTrack) {
			this.deferredStart = null
			this.lastReachedAt = undefined
			this.runningObservation = null
		}
		this.pollFailureCount = 0
		this.target = target
		if (clearTrack) {
			this.track = null
			this.trackEtag = null
			this.lookup = null
		}
		return this.revision
	}

	private abortPending(): void {
		this.abortController?.abort()
		this.abortController = null
		if (this.pollTimer !== null) {
			clearTimeout(this.pollTimer)
			this.pollTimer = null
		}
	}

	private isCurrent(revision: number): boolean {
		return revision === this.revision && !this.abortController?.signal.aborted
	}

	private currentTarget(): CaptionTarget | null {
		return this.target
	}

	private publish(snapshot: CaptionSessionState): void {
		this.snapshot = {
			...snapshot,
			...(this.connectionIssue
				? { connectionIssue: this.connectionIssue }
				: {}),
		}
		for (const listener of this.listeners) {
			listener()
		}
	}

	private async loadCached(
		target: CaptionTarget,
		revision: number
	): Promise<StoredCaptionTrack | null> {
		const storedPath = pathKey(target.path)
		let cached: StoredCaptionTrack | null
		try {
			cached = await this.repository.getCaptionTrack(
				target.infoHash,
				storedPath
			)
		} catch (error) {
			this.publishErrorIfCurrent(error, revision, false)
			return null
		}
		if (!(this.isCurrent(revision) && cached)) {
			return null
		}
		if (cached.fileLength !== target.fileLength) {
			await this.removeInvalidCache(target, revision, cached)
			return null
		}
		try {
			this.installTrack(
				decodeCaptionTrack(new Uint8Array(cached.bytes)),
				cached.etag
			)
			this.publish({ cached: true, phase: 'ready', status: null })
			return cached
		} catch {
			await this.removeInvalidCache(target, revision, cached)
			if (this.isCurrent(revision)) {
				this.publish({
					cached: false,
					message: 'Saved captions are unreadable.',
					phase: 'loading',
					status: null,
				})
			}
			return null
		}
	}

	private async removeInvalidCache(
		target: CaptionTarget,
		revision: number,
		observed: StoredCaptionTrack
	): Promise<void> {
		try {
			await this.repository.removeCaptionTrack(
				target.infoHash,
				pathKey(target.path),
				{
					...(observed.artifactUpdatedAt
						? { artifactUpdatedAt: observed.artifactUpdatedAt }
						: {}),
					etag: observed.etag,
					updatedAt: observed.updatedAt,
				}
			)
		} catch {
			// A broken cache entry must not block a fresh server copy.
		}
		if (this.isCurrent(revision)) {
			this.track = null
			this.trackEtag = null
			this.lookup = null
		}
	}

	private installTrack(track: DecodedTrack, etag: string): void {
		this.track = track
		this.trackEtag = etag
		this.lookup = createCaptionLookup(track)
	}

	private async boundedServiceCall<Value>(
		serviceOperation: ServiceOperation,
		timeoutMessage: string,
		operation: (signal: AbortSignal) => Promise<Value>
	): Promise<Value> {
		const sessionSignal = this.abortController?.signal
		if (!sessionSignal || sessionSignal.aborted) {
			throw abortError()
		}
		if (this.serviceCalls.has(serviceOperation)) {
			throw new CaptionServiceBusyError(serviceOperation)
		}
		const requestController = new AbortController()
		let rejectInterruption: (error: Error) => void = () => undefined
		const interrupted = new Promise<never>((_resolve, reject) => {
			rejectInterruption = reject
		})
		const abortRequest = (): void => {
			rejectInterruption(abortError())
			requestController.abort()
		}
		sessionSignal.addEventListener('abort', abortRequest, { once: true })
		const timeout = setTimeout(() => {
			rejectInterruption(new CaptionServiceTimeoutError(timeoutMessage))
			requestController.abort()
		}, this.serviceRequestTimeoutMs)
		let trackedOperation: Promise<Value>
		const physicalOperation = Promise.resolve().then(() =>
			operation(requestController.signal)
		)
		const { serviceCalls } = this
		trackedOperation = physicalOperation.finally(() => {
			if (serviceCalls.get(serviceOperation) === trackedOperation) {
				serviceCalls.delete(serviceOperation)
			}
		})
		this.serviceCalls.set(serviceOperation, trackedOperation)
		try {
			return await Promise.race([trackedOperation, interrupted])
		} finally {
			clearTimeout(timeout)
			sessionSignal.removeEventListener('abort', abortRequest)
		}
	}

	private requestStatus(
		target: CaptionTarget
	): Promise<TranscriptionStatus | null> {
		return this.boundedServiceCall(
			'status',
			'Transcription status request timed out.',
			(signal) => this.api.getStatus(target.infoHash, target.fileId, signal)
		)
	}

	private startTranscription(
		target: CaptionTarget
	): Promise<TranscriptionStatus> {
		return this.boundedServiceCall(
			'start',
			'Starting transcription timed out.',
			(signal) => this.api.start(target.infoHash, target.fileId, signal)
		)
	}

	private cancelTranscription(target: CaptionTarget): Promise<void> {
		return this.boundedServiceCall(
			'cancel',
			'Cancelling transcription timed out.',
			(signal) => this.api.cancel(target.infoHash, target.fileId, signal)
		)
	}

	private requestTrack(
		target: CaptionTarget,
		etag: string | undefined
	): ReturnType<CaptionService['getTrack']> {
		return this.boundedServiceCall(
			'track',
			'Caption download timed out.',
			(signal) =>
				this.api.getTrack(target.infoHash, target.fileId, etag, signal)
		)
	}

	private async synchronize(
		revision: number,
		cached: StoredCaptionTrack | null
	): Promise<void> {
		const target = this.currentTarget()
		if (!target) {
			return
		}
		let status: TranscriptionStatus | null
		try {
			status = await this.requestStatus(target)
		} catch (error) {
			this.handleStatusRequestError(error, revision, cached !== null, null)
			return
		}
		if (!this.isCurrent(revision)) {
			return
		}
		if (!status) {
			this.applyMissingStatus(revision, cached !== null)
			return
		}
		await this.applyStatusSafely(status, revision, cached !== null)
	}

	private async applyStatus(
		status: TranscriptionStatus,
		revision: number,
		isCached: boolean
	): Promise<void> {
		if (!this.isCurrent(revision)) {
			return
		}
		this.waitingForServerAudio = null
		this.noteReachable(status)
		const cacheAvailable = await this.cacheAvailableForStatus(
			status,
			revision,
			isCached
		)
		if (cacheAvailable === null) {
			return
		}
		if (
			await this.applyCleanupPendingIfNeeded(status, revision, cacheAvailable)
		) {
			return
		}
		if (
			await this.resumeDeferredStartIfNeeded(status, revision, cacheAvailable)
		) {
			return
		}
		switch (status.state) {
			case 'cancelled':
				this.applyCancelledStatus(status, cacheAvailable)
				this.finishRequest(revision)
				return
			case 'failed':
				this.applyFailedStatus(status, cacheAvailable)
				this.finishRequest(revision)
				return
			case 'preparing':
			case 'queued':
			case 'transcribing':
				this.deferredStart = null
				this.applyRunningStatus(status, revision, cacheAvailable)
				return
			case 'completed':
				this.deferredStart = null
				await this.loadCompletedTrack(status, revision, cacheAvailable)
				this.finishRequest(revision)
				return
			default:
				return
		}
	}

	private async cacheAvailableForStatus(
		status: TranscriptionStatus,
		revision: number,
		isCached: boolean
	): Promise<boolean | null> {
		if (
			status.state === 'completed' ||
			!status.captions ||
			this.trackEtag === status.captions.etag
		) {
			return isCached
		}
		try {
			await this.loadCompletedTrack(status, revision, false)
		} catch (error) {
			if (!this.isCurrent(revision) || isAbortError(error)) {
				return null
			}
			if (!this.track) {
				throw error
			}
		}
		return this.isCurrent(revision) ? this.snapshot.cached : null
	}

	private async applyCleanupPendingIfNeeded(
		status: TranscriptionStatus,
		revision: number,
		isCached: boolean
	): Promise<boolean> {
		if (!status.cleanupPending) {
			return false
		}
		if (status.state === 'completed') {
			await this.applyCompletedCleanupPendingStatus(status, revision, isCached)
			return true
		}
		this.applyCleanupPendingStatus(status, revision, isCached)
		return true
	}

	private async resumeDeferredStartIfNeeded(
		status: TranscriptionStatus,
		revision: number,
		isCached: boolean
	): Promise<boolean> {
		if (
			!(
				this.deferredStart &&
				(status.state === 'cancelled' || status.state === 'failed')
			)
		) {
			return false
		}
		const target = this.currentTarget()
		if (!target) {
			return false
		}
		await this.resumeDeferredStart(target, status, revision, isCached)
		return true
	}

	private async applyStatusSafely(
		status: TranscriptionStatus,
		revision: number,
		isCached: boolean
	): Promise<void> {
		try {
			await this.applyStatus(status, revision, isCached)
		} catch (error) {
			if (isCaptionTransportError(error)) {
				if (status.state === 'completed') {
					this.publishCaptionArtifactFailure(error, revision, isCached, status)
					this.schedulePoll(revision, this.snapshot.cached, true)
					return
				}
				this.publishStatusUnavailable(error, revision, isCached, status)
				this.schedulePoll(revision, this.snapshot.cached, true)
				return
			}
			this.publishCaptionArtifactFailure(error, revision, isCached, status)
			if (status.cleanupPending) {
				this.schedulePoll(revision, this.snapshot.cached)
			} else {
				this.finishRequest(revision)
			}
		}
	}

	private applyRunningStatus(
		status: TranscriptionStatus,
		revision: number,
		isCached: boolean
	): void {
		const queueBlockedMessage = status.queueBlockedByCleanup
			? 'Waiting for the previous chapter to release local transcription resources.'
			: undefined
		const currentTrackLabel = isCached
			? 'Saved captions are shown.'
			: 'Captions are shown but are not saved offline.'
		const refreshedTrackMessage = isCached
			? 'Saved captions are shown while a refreshed track is prepared.'
			: 'Captions are shown while a refreshed track is prepared; they are not saved offline.'
		const trackMessage = queueBlockedMessage
			? `${currentTrackLabel} ${queueBlockedMessage}`
			: refreshedTrackMessage
		this.publish(
			this.track
				? {
						cached: isCached,
						message: trackMessage,
						phase: 'ready',
						status,
					}
				: {
						cached: false,
						...(queueBlockedMessage ? { message: queueBlockedMessage } : {}),
						phase: runningPhase(status),
						status,
					}
		)
		this.schedulePoll(revision, isCached)
	}

	private applyFailedStatus(
		status: TranscriptionStatus,
		isCached: boolean
	): void {
		this.publish(
			this.track
				? {
						cached: isCached,
						message:
							`${isCached ? 'Saved captions are shown' : 'Captions are shown but are not saved offline'}; refresh failed. ${status.error?.message ?? ''}`.trim(),
						phase: 'ready',
						status,
					}
				: {
						cached: false,
						message: status.error?.message ?? 'Transcription failed.',
						phase: 'failed',
						status,
					}
		)
	}

	private applyCancelledStatus(
		status: TranscriptionStatus,
		isCached: boolean
	): void {
		this.publish(
			this.track
				? {
						cached: isCached,
						message: isCached
							? 'Saved captions are shown; refresh was cancelled.'
							: 'Captions are shown but are not saved offline; refresh was cancelled.',
						phase: 'ready',
						status,
					}
				: {
						cached: false,
						message: 'Transcription was cancelled.',
						phase: 'cancelled',
						status,
					}
		)
	}

	private applyCleanupPendingStatus(
		status: TranscriptionStatus,
		revision: number,
		isCached: boolean
	): void {
		const cancellationAccepted = status.state === 'cancelled'
		const cleanupMessage = cancellationAccepted
			? 'Cancellation was accepted. TPlayer is releasing local transcription resources before this chapter can be restarted.'
			: `${status.error?.message ?? 'Transcription stopped.'} TPlayer is releasing local transcription resources before this chapter can be retried.`
		this.publish(
			this.track
				? {
						cached: isCached,
						message: `${isCached ? 'Saved captions are shown.' : 'Captions remain available for this session but are not saved offline.'} ${cleanupMessage}`,
						phase: 'ready',
						status,
					}
				: {
						cached: false,
						message: cleanupMessage,
						phase: cancellationAccepted ? 'cancelling' : 'cleaning',
						status,
					}
		)
		this.schedulePoll(revision, isCached)
	}

	private async applyCompletedCleanupPendingStatus(
		status: TranscriptionStatus,
		revision: number,
		isCached: boolean
	): Promise<void> {
		await this.loadCompletedTrack(status, revision, isCached)
		if (!(this.isCurrent(revision) && this.track)) {
			return
		}
		const { cached } = this.snapshot
		this.publish({
			cached,
			message: cached
				? 'Captions are ready and saved offline. TPlayer is releasing local audio resources.'
				: 'Captions are ready. TPlayer is releasing local audio resources; they are not saved offline yet.',
			phase: 'ready',
			status,
		})
		this.schedulePoll(revision, cached)
	}

	private async observeDeferredCleanup(
		target: CaptionTarget,
		previousStatus: TranscriptionStatus | null,
		revision: number,
		isCached: boolean
	): Promise<void> {
		let status: TranscriptionStatus | null
		try {
			status = await this.requestStatus(target)
		} catch (error) {
			this.handleStatusRequestError(error, revision, isCached, previousStatus)
			return
		}
		if (!this.isCurrent(revision)) {
			return
		}
		if (status) {
			await this.applyStatusSafely(status, revision, isCached)
			return
		}
		await this.resumeDeferredStart(target, previousStatus, revision, isCached)
	}

	private async resumeDeferredStart(
		target: CaptionTarget,
		previousStatus: TranscriptionStatus | null,
		revision: number,
		isCached: boolean
	): Promise<void> {
		const intent = this.deferredStart
		if (!(intent && this.isCurrent(revision))) {
			return
		}
		this.deferredStart = null
		this.publish(
			this.track
				? {
						cached: isCached,
						message:
							intent === 'restart'
								? 'Local cleanup finished. Restarting transcription…'
								: 'Local cleanup finished. Retrying transcription…',
						phase: 'ready',
						status: previousStatus,
					}
				: {
						cached: false,
						message:
							intent === 'restart'
								? 'Local cleanup finished. Restarting transcription…'
								: 'Local cleanup finished. Retrying transcription…',
						phase: 'loading',
						status: previousStatus,
					}
		)
		try {
			const status = await this.startTranscription(target)
			if (this.isCurrent(revision)) {
				await this.applyStatusSafely(status, revision, isCached)
			}
		} catch (error) {
			if (isCleanupPendingError(error)) {
				this.deferredStart = intent
				this.publish(
					this.track
						? {
								cached: isCached,
								message:
									'Saved captions are shown. Local transcription resources are still being released.',
								phase: 'ready',
								status: previousStatus,
							}
						: {
								cached: false,
								message:
									'Local transcription resources are still being released.',
								phase: 'cleaning',
								status: previousStatus,
							}
				)
				this.schedulePoll(revision, isCached)
				return
			}
			if (!isDefinitiveApiError(error)) {
				this.publishStatusUnavailable(error, revision, isCached, previousStatus)
				this.schedulePoll(revision, this.snapshot.cached, true)
				return
			}
			if (intent === 'restart') {
				this.publishRestartFailure(error, revision, isCached, previousStatus)
			} else {
				this.publishErrorIfCurrent(error, revision, isCached, previousStatus)
			}
			if (isAudioNotLocalError(error)) {
				this.waitingForServerAudio = actionErrorMetadata(error)
				this.schedulePoll(revision, isCached)
				return
			}
			this.finishRequest(revision)
		}
	}

	private publishUnverifiedCancellation(
		previousStatus: TranscriptionStatus | null,
		isCached: boolean,
		verificationDetail?: string
	): void {
		const status = asCancelledStatus(previousStatus)
		const detail = verificationDetail ? ` ${verificationDetail}` : ''
		this.publish(
			this.track
				? {
						cached: isCached,
						message: isCached
							? `Saved captions are shown; cancellation was accepted, but its final server status could not be confirmed.${detail}`
							: `Captions remain available for this session; cancellation was accepted, but its final server status could not be confirmed.${detail}`,
						phase: 'ready',
						status,
					}
				: {
						cached: false,
						message: `Cancellation was accepted, but its final server status could not be confirmed.${detail}`,
						phase: 'cancelled',
						status,
					}
		)
	}

	private applyMissingStatus(revision: number, isCached: boolean): void {
		if (!this.isCurrent(revision)) {
			return
		}
		this.noteReachable()
		if (this.waitingForServerAudio) {
			this.publish({
				actionError: this.waitingForServerAudio,
				cached: isCached,
				message: this.waitingForServerAudio.message,
				phase: this.track ? 'ready' : 'failed',
				status: null,
			})
			this.schedulePoll(revision, isCached)
			return
		}
		if (this.track) {
			this.publish({
				cached: isCached,
				...(isCached
					? {
							message:
								'Saved captions are available; no server transcription job is running.',
						}
					: {
							message:
								'Captions remain available for this session but are not saved offline.',
						}),
				phase: 'ready',
				status: null,
			})
			this.finishRequest(revision)
			return
		}
		this.publish({
			cached: false,
			message:
				'No captions are available yet. Transcribe this chapter now or enable automatic transcription in Settings.',
			phase: 'unavailable',
			status: null,
		})
		this.finishRequest(revision)
	}

	private finishRequest(revision: number): void {
		if (revision !== this.revision) {
			return
		}
		if (this.pollTimer !== null) {
			clearTimeout(this.pollTimer)
			this.pollTimer = null
		}
		this.deferredStart = null
		this.waitingForServerAudio = null
		this.abortController = null
	}

	private noteReachable(status?: TranscriptionStatus): void {
		const nowMilliseconds = this.now()
		const reachedAt = new Date(nowMilliseconds).toISOString()
		this.lastReachedAt = reachedAt
		this.pollFailureCount = 0
		if (status && this.runningStatusIsStalled(status)) {
			this.connectionIssue = {
				consecutiveFailures: 0,
				detectedAt:
					this.connectionIssue?.kind === 'stalled'
						? this.connectionIssue.detectedAt
						: reachedAt,
				kind: 'stalled',
				lastReachedAt: reachedAt,
			}
			return
		}
		this.connectionIssue = undefined
	}

	private runningStatusIsStalled(status: TranscriptionStatus): boolean {
		if (!(status.state === 'preparing' || status.state === 'transcribing')) {
			this.runningObservation = null
			return false
		}
		if (status.watchdogRemainingMilliseconds !== undefined) {
			this.observeRunningStatus(status, status.state)
			return status.watchdogRemainingMilliseconds === 0
		}
		const elapsedMilliseconds = this.elapsedNow()
		const observation = this.runningObservation
		const statusChanged =
			!observation ||
			observation.attempt !== status.attempt ||
			observation.fileId !== status.fileId ||
			observation.processedMilliseconds !== status.processedMilliseconds ||
			observation.state !== status.state ||
			observation.updatedAt !== status.updatedAt
		if (statusChanged) {
			this.runningObservation = {
				attempt: status.attempt,
				fileId: status.fileId,
				observedAt: elapsedMilliseconds,
				processedMilliseconds: status.processedMilliseconds,
				state: status.state,
				unchangedPolls: 0,
				updatedAt: status.updatedAt,
			}
			return false
		}
		observation.unchangedPolls += 1
		return (
			observation.unchangedPolls >= 2 &&
			elapsedMilliseconds - observation.observedAt >= this.stallAfterMs
		)
	}

	private observeRunningStatus(
		status: TranscriptionStatus,
		state: RunningObservation['state']
	): void {
		this.runningObservation = {
			attempt: status.attempt,
			fileId: status.fileId,
			observedAt: this.elapsedNow(),
			processedMilliseconds: status.processedMilliseconds,
			state,
			unchangedPolls: 0,
			updatedAt: status.updatedAt,
		}
	}

	private noteUnreachable(): void {
		const detectedAt = new Date(this.now()).toISOString()
		this.connectionIssue = {
			consecutiveFailures: this.pollFailureCount,
			detectedAt:
				this.connectionIssue?.kind === 'unreachable'
					? this.connectionIssue.detectedAt
					: detectedAt,
			kind: 'unreachable',
			...(this.lastReachedAt ? { lastReachedAt: this.lastReachedAt } : {}),
		}
	}

	private publishRestartFailure(
		error: unknown,
		revision: number,
		isCached: boolean,
		previousStatus: TranscriptionStatus | null
	): void {
		if (!this.isCurrent(revision) || isAbortError(error)) {
			return
		}
		const status = asCancelledStatus(previousStatus)
		const message = `Transcription was cancelled, but it could not be restarted. ${errorMessage(error)}`
		const actionError = isDefinitiveApiError(error)
			? actionErrorMetadata(error)
			: undefined
		this.publish(
			this.track
				? {
						...(actionError ? { actionError } : {}),
						cached: isCached,
						message,
						phase: 'ready',
						status,
					}
				: {
						...(actionError ? { actionError } : {}),
						cached: false,
						message,
						phase: 'failed',
						status,
					}
		)
	}

	private publishActionRejection(
		message: string,
		revision: number,
		isCached: boolean,
		status: TranscriptionStatus | null,
		error?: CaptionApiError
	): void {
		if (!this.isCurrent(revision)) {
			return
		}
		this.connectionIssue = undefined
		const actionError = error ? actionErrorMetadata(error) : undefined
		this.publish(
			this.track
				? {
						...(actionError ? { actionError } : {}),
						cached: isCached,
						message,
						phase: 'ready',
						status,
					}
				: {
						...(actionError ? { actionError } : {}),
						cached: false,
						message,
						phase:
							statusIsRunning(status) && status
								? runningPhase(status)
								: 'failed',
						status,
					}
		)
	}

	private publishCaptionArtifactFailure(
		error: unknown,
		revision: number,
		isCached: boolean,
		status: TranscriptionStatus
	): void {
		if (!this.isCurrent(revision) || isAbortError(error)) {
			return
		}
		this.connectionIssue = undefined
		const detail = errorMessage(error)
		const cleanupDetail = status.cleanupPending
			? ' TPlayer is still releasing local audio resources.'
			: ''
		this.publish(
			this.track
				? {
						cached: isCached,
						message: `${isCached ? 'Saved captions remain available.' : 'Captions remain available for this session but are not saved offline.'} The new caption file could not be loaded. ${detail}${cleanupDetail}`,
						phase: 'ready',
						status,
					}
				: {
						cached: false,
						message: `The caption file could not be loaded. ${detail}${cleanupDetail}`,
						phase: 'failed',
						status,
					}
		)
	}

	private publishDefinitiveStatusError(
		error: CaptionApiError,
		revision: number,
		isCached: boolean,
		status: TranscriptionStatus | null
	): void {
		this.publishActionRejection(
			`The server could not report transcription status. ${error.message}`,
			revision,
			isCached,
			status
		)
	}

	private publishStatusUnavailable(
		error: unknown,
		revision: number,
		isCached: boolean,
		status: TranscriptionStatus | null
	): void {
		if (!this.isCurrent(revision) || isAbortError(error)) {
			return
		}
		this.pollFailureCount += 1
		this.noteUnreachable()
		const requestDetail =
			error instanceof CaptionServiceTimeoutError ||
			error instanceof CaptionServiceBusyError
				? error.message
				: 'The transcription service could not be reached.'
		if (this.track) {
			this.publish({
				cached: isCached,
				message: isCached
					? `Saved captions are available. ${requestDetail}`
					: `Captions remain available for this session but are not saved offline. ${requestDetail}`,
				phase: 'ready',
				status,
			})
			return
		}
		const lastReportedState = statusIsRunning(status)
		this.publish({
			cached: false,
			message: lastReportedState
				? `${requestDetail} Last reported progress is shown while TPlayer keeps checking without duplicating requests.`
				: `${requestDetail} TPlayer will keep checking without duplicating requests.`,
			phase: lastReportedState && status ? runningPhase(status) : 'failed',
			status,
		})
	}

	private schedulePoll(
		revision: number,
		isCached: boolean,
		retryingAfterFailure = false
	): void {
		if (!this.isCurrent(revision)) {
			return
		}
		if (this.pollTimer !== null) {
			clearTimeout(this.pollTimer)
		}
		const delay = retryingAfterFailure
			? Math.min(
					this.pollIntervalMs * 2 ** Math.min(this.pollFailureCount, 4),
					30_000
				)
			: this.pollIntervalMs
		this.pollTimer = setTimeout(() => {
			this.pollTimer = null
			this.poll(revision, isCached).catch((error: unknown) => {
				this.handleStatusPollingError(error, revision, isCached)
			})
		}, delay)
	}

	private handleStatusPollingError(
		error: unknown,
		revision: number,
		isCached: boolean
	): void {
		this.handleStatusRequestError(
			error,
			revision,
			isCached,
			this.snapshot.status
		)
	}

	private handleStatusRequestError(
		error: unknown,
		revision: number,
		isCached: boolean,
		status: TranscriptionStatus | null
	): void {
		if (!(this.isCurrent(revision) && !isAbortError(error))) {
			return
		}
		if (isDefinitiveApiError(error)) {
			this.pollFailureCount += 1
			this.publishDefinitiveStatusError(error, revision, isCached, status)
		} else {
			this.publishStatusUnavailable(error, revision, isCached, status)
		}
		this.schedulePoll(revision, this.snapshot.cached, true)
	}

	private async poll(revision: number, isCached: boolean): Promise<void> {
		const target = this.currentTarget()
		if (!(target && this.isCurrent(revision))) {
			return
		}
		const status = await this.requestStatus(target)
		if (!this.isCurrent(revision)) {
			return
		}
		if (!status) {
			this.applyMissingStatus(revision, isCached)
			return
		}
		await this.applyStatusSafely(status, revision, isCached)
	}

	private async loadCompletedTrack(
		status: TranscriptionStatus,
		revision: number,
		isCached: boolean
	): Promise<void> {
		const target = this.currentTarget()
		const metadata = status.captions
		if (!(target && metadata)) {
			this.publishErrorIfCurrent(
				new Error('Completed transcription has no caption artifact'),
				revision,
				isCached
			)
			return
		}
		if (await this.restorePersistedTrack(target, metadata, status, revision)) {
			return
		}
		if (this.track && this.trackEtag === metadata.etag) {
			this.publish({ cached: isCached, phase: 'ready', status })
			return
		}
		let downloaded = await this.requestTrack(
			target,
			this.trackEtag ?? undefined
		)
		if (!this.isCurrent(revision)) {
			return
		}
		if (downloaded.kind === 'not-modified') {
			if (!this.track) {
				throw new Error(
					'Server reported unchanged captions without a local copy'
				)
			}
			if (
				await this.promoteNotModifiedTrack(
					target,
					downloaded.artifactUpdatedAt,
					status,
					revision
				)
			) {
				return
			}
			downloaded = await this.requestTrack(target, undefined)
			if (!this.isCurrent(revision)) {
				return
			}
			if (downloaded.kind === 'not-modified') {
				throw new Error(
					'Server reported unchanged captions for an unconditional request'
				)
			}
		}
		if (downloaded.kind === 'missing') {
			throw new Error('Caption artifact is no longer available on the server')
		}

		const decoded = decodeCaptionTrack(new Uint8Array(downloaded.bytes))
		this.installTrack(decoded, downloaded.etag)
		this.publish({ cached: false, phase: 'ready', status })
		const record: StoredCaptionTrack = {
			artifactUpdatedAt: downloaded.artifactUpdatedAt,
			bytes: downloaded.bytes,
			cueCount: decoded.segmentCount,
			durationMilliseconds: decoded.durationMs,
			etag: downloaded.etag,
			fileLength: target.fileLength,
			formatVersion: decoded.formatVersion,
			ih: target.infoHash,
			...(metadata.language ? { language: metadata.language } : {}),
			path: pathKey(target.path),
			updatedAt: Date.now(),
		}
		await this.persistDownloadedTrack(record, target, status, revision, false)
	}

	private async restorePersistedTrack(
		target: CaptionTarget,
		metadata: CompletedCaptionMetadata,
		status: TranscriptionStatus,
		revision: number
	): Promise<boolean> {
		let persisted: StoredCaptionTrack | null = null
		try {
			persisted = await this.repository.getCaptionTrack(
				target.infoHash,
				pathKey(target.path)
			)
		} catch {
			// IndexedDB availability must not block a server-backed caption track.
		}
		if (!this.isCurrent(revision)) {
			return true
		}
		if (!(persisted && storedTrackCanSatisfy(persisted, target, metadata))) {
			return false
		}
		try {
			if (this.trackEtag !== persisted.etag) {
				this.installTrack(
					decodeCaptionTrack(new Uint8Array(persisted.bytes)),
					persisted.etag
				)
			}
			if (
				storedTrackNeedsRevisionPromotion(
					persisted,
					metadata.etag,
					metadata.updatedAt
				)
			) {
				await this.persistDownloadedTrack(
					{
						...persisted,
						artifactUpdatedAt: metadata.updatedAt,
						updatedAt: Date.now(),
					},
					target,
					status,
					revision,
					true
				)
				return true
			}
			this.publish({ cached: true, phase: 'ready', status })
			return true
		} catch {
			try {
				await this.repository.removeCaptionTrack(
					target.infoHash,
					pathKey(target.path),
					persisted
				)
			} catch {
				// A corrupt cached candidate must not block the server copy.
			}
			return false
		}
	}

	private async promoteNotModifiedTrack(
		target: CaptionTarget,
		artifactUpdatedAt: string,
		status: TranscriptionStatus,
		revision: number
	): Promise<boolean> {
		let persisted: StoredCaptionTrack | null
		try {
			persisted = await this.repository.getCaptionTrack(
				target.infoHash,
				pathKey(target.path)
			)
		} catch {
			return false
		}
		if (!this.isCurrent(revision)) {
			return true
		}
		if (
			!(
				persisted &&
				persisted.fileLength === target.fileLength &&
				persisted.etag === this.trackEtag
			)
		) {
			return false
		}
		if (
			!storedTrackNeedsRevisionPromotion(
				persisted,
				persisted.etag,
				artifactUpdatedAt
			)
		) {
			this.publish({ cached: true, phase: 'ready', status })
			return true
		}
		await this.persistDownloadedTrack(
			{
				...persisted,
				artifactUpdatedAt,
				updatedAt: Date.now(),
			},
			target,
			status,
			revision,
			true
		)
		return true
	}

	private async persistDownloadedTrack(
		record: StoredCaptionTrack,
		target: CaptionTarget,
		status: TranscriptionStatus,
		revision: number,
		cacheAvailableOnFailure: boolean
	): Promise<void> {
		try {
			await this.repository.putCaptionTrack(record)
			const selected = await this.repository.getCaptionTrack(
				target.infoHash,
				pathKey(target.path)
			)
			if (!this.isCurrent(revision)) {
				return
			}
			if (!(selected && selected.fileLength === target.fileLength)) {
				throw new Error('Saved captions disappeared before they were verified')
			}
			if (this.trackEtag !== selected.etag) {
				this.installTrack(
					decodeCaptionTrack(new Uint8Array(selected.bytes)),
					selected.etag
				)
			}
			this.publish({ cached: true, phase: 'ready', status })
		} catch (error) {
			if (!(this.isCurrent(revision) && !isAbortError(error))) {
				return
			}
			this.publish({
				cached: cacheAvailableOnFailure,
				message: cacheAvailableOnFailure
					? 'Saved captions are available, but their cache revision could not be refreshed.'
					: 'Captions are available but could not be saved offline.',
				phase: 'ready',
				status,
			})
		}
	}

	private publishErrorIfCurrent(
		error: unknown,
		revision: number,
		isCached: boolean,
		status: TranscriptionStatus | null = this.snapshot.status
	): void {
		if (!this.isCurrent(revision) || isAbortError(error)) {
			return
		}
		const actionError = isDefinitiveApiError(error)
			? actionErrorMetadata(error)
			: undefined
		if (this.track) {
			this.publish({
				...(actionError ? { actionError } : {}),
				cached: isCached,
				message: `${isCached ? 'Saved captions remain available.' : 'Captions remain available for this session but are not saved offline.'} ${errorMessage(error)}`,
				phase: 'ready',
				status,
			})
			return
		}
		this.publish({
			...(actionError ? { actionError } : {}),
			cached: false,
			message: errorMessage(error),
			phase: 'failed',
			status,
		})
	}
}

import { Howl } from 'howler'

const noOperation = () => undefined
const COMPLETED_RESUME_TOLERANCE_SECONDS = 0.05
const PROGRESS_CONFIRMATION_TOLERANCE_SECONDS = 0.75
const PROGRESS_SETTLE_MINIMUM_MS = 800
const PROGRESS_SETTLE_TIMEOUT_MS = 4000

const defaultCallbacks = {
	onEnd: noOperation,
	onError: noOperation,
	onLoad: noOperation,
	onPause: noOperation,
	onPlay: noOperation,
}

const toPlaybackError = (error) => {
	if (error instanceof Error) {
		return error
	}
	return new Error(`Audio playback failed: ${String(error)}`)
}

const finiteNumber = (value, fallback = 0) => {
	const numericValue = Number(value)
	return Number.isFinite(numericValue) ? numericValue : fallback
}

export class Player {
	constructor() {
		this.callbacks = defaultCallbacks
		this.displayTime = 0
		this.howler = null
		this.pendingSeek = null
		this.playbackRate = 1
		this.playRequested = false
		this.progressSettlement = null
		this.sourceRevision = 0
	}

	setCallbacks(callbacks = {}) {
		this.callbacks = { ...defaultCallbacks, ...callbacks }
	}

	loadSource({ format, rate, resumeTime = 0, url, volume }) {
		this.sourceRevision += 1
		const revision = this.sourceRevision
		this.howler?.unload()
		this.displayTime = 0
		this.pendingSeek = Math.max(0, finiteNumber(resumeTime))
		this.playbackRate = Math.max(0, finiteNumber(rate, 1))
		this.playRequested = false
		this.progressSettlement = null

		const options = {
			html5: true,
			onend: () => {
				if (this.isCurrentRevision(revision)) {
					this.playRequested = false
					this.callbacks.onEnd({
						currentTime: this.currentTime,
						duration: this.duration,
					})
				}
			},
			onload: () => {
				if (!this.isCurrentRevision(revision)) {
					return
				}
				this.applyPendingSeek()
				this.callbacks.onLoad()
			},
			onloaderror: (_soundId, error) => {
				if (this.isCurrentRevision(revision)) {
					this.playRequested = false
					this.callbacks.onError(toPlaybackError(error))
				}
			},
			onpause: () => {
				if (this.isCurrentRevision(revision)) {
					this.playRequested = false
					this.callbacks.onPause()
				}
			},
			onplay: () => {
				if (this.isCurrentRevision(revision)) {
					this.playRequested = true
					this.callbacks.onPlay()
				}
			},
			onplayerror: (_soundId, error) => {
				if (this.isCurrentRevision(revision)) {
					this.playRequested = false
					this.callbacks.onError(toPlaybackError(error))
				}
			},
			preload: 'metadata',
			rate,
			src: [url],
			volume,
		}
		if (format) {
			options.format = [format]
		}
		this.howler = new Howl(options)
	}

	play() {
		if (!this.howler) {
			return false
		}
		if (!this.howler.playing()) {
			this.playRequested = true
			const { duration } = this
			const replayingCompletedSource =
				duration > 0 &&
				this.displayTime >= duration - COMPLETED_RESUME_TOLERANCE_SECONDS
			if (replayingCompletedSource) {
				this.displayTime = 0
				this.progressSettlement = null
			} else {
				this.startProgressSettlement(this.displayTime, true)
			}
			this.howler.play()
		}
		return true
	}

	pause() {
		if (!this.howler) {
			return false
		}
		this.playRequested = false
		this.howler.pause()
		return true
	}

	seekTo(time) {
		const requestedTime = Math.max(0, finiteNumber(time))
		if (!(this.howler && this.duration > 0)) {
			this.pendingSeek = requestedTime
			return
		}
		this.pendingSeek = null
		const nextTime = Math.min(requestedTime, this.duration)
		this.startProgressSettlement(
			nextTime,
			this.playRequested || this.howler.playing()
		)
		this.howler.seek(nextTime)
	}

	changeVolume(value) {
		this.howler?.volume(value)
	}

	changeRate(value) {
		this.playbackRate = Math.max(0, finiteNumber(value, 1))
		this.howler?.rate(value)
	}

	unloadSource() {
		this.sourceRevision += 1
		this.displayTime = 0
		this.pendingSeek = null
		this.playRequested = false
		this.progressSettlement = null
		this.howler?.unload()
		this.howler = null
	}

	dispose() {
		this.unloadSource()
		this.callbacks = defaultCallbacks
	}

	get currentTime() {
		const engineTime = finiteNumber(this.howler?.seek(), this.displayTime)
		const settlement = this.progressSettlement
		if (!settlement) {
			this.displayTime = engineTime
			return engineTime
		}

		const now = Date.now()
		const settlementAge = now - settlement.startedAt
		if (settlementAge >= PROGRESS_SETTLE_TIMEOUT_MS) {
			this.progressSettlement = null
			this.displayTime = engineTime
			return engineTime
		}

		if (!settlement.confirmed) {
			const reachedTarget =
				Math.abs(engineTime - settlement.target) <=
				PROGRESS_CONFIRMATION_TOLERANCE_SECONDS
			if (!reachedTarget) {
				return this.displayTime
			}
			settlement.confirmed = true
			settlement.lastSampleAt = now
			this.displayTime = engineTime
			return engineTime
		}

		const elapsedSinceSample = Math.max(0, now - settlement.lastSampleAt)
		const expectedAdvance = settlement.advancing
			? (elapsedSinceSample / 1000) * this.playbackRate
			: 0
		const lowerBound =
			this.displayTime - PROGRESS_CONFIRMATION_TOLERANCE_SECONDS
		const upperBound =
			this.displayTime +
			PROGRESS_CONFIRMATION_TOLERANCE_SECONDS +
			expectedAdvance
		if (engineTime < lowerBound || engineTime > upperBound) {
			return this.displayTime
		}

		this.displayTime = engineTime
		settlement.lastSampleAt = now
		if (settlementAge >= PROGRESS_SETTLE_MINIMUM_MS) {
			this.progressSettlement = null
		}
		return engineTime
	}

	get duration() {
		const duration = finiteNumber(this.howler?.duration())
		return duration > 0 ? duration : 0
	}

	applyPendingSeek() {
		if (this.pendingSeek === null || this.duration <= 0) {
			return
		}
		const requestedTime = this.pendingSeek
		this.pendingSeek = null
		const nextTime = Math.min(requestedTime, this.duration)
		this.startProgressSettlement(
			nextTime,
			this.playRequested || Boolean(this.howler?.playing())
		)
		this.howler?.seek(nextTime)
	}

	startProgressSettlement(target, advancing) {
		const normalizedTarget = Math.max(0, finiteNumber(target))
		const now = Date.now()
		this.displayTime = normalizedTarget
		this.progressSettlement = {
			advancing: Boolean(advancing),
			confirmed: false,
			lastSampleAt: now,
			startedAt: now,
			target: normalizedTarget,
		}
	}

	isCurrentRevision(revision) {
		return revision === this.sourceRevision
	}
}

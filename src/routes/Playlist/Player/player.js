import { Howl } from 'howler'

const noOperation = () => undefined

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
		this.howler = null
		this.pendingSeek = null
		this.sourceRevision = 0
	}

	setCallbacks(callbacks = {}) {
		this.callbacks = { ...defaultCallbacks, ...callbacks }
	}

	loadSource({ format, rate, resumeTime = 0, url, volume }) {
		this.sourceRevision += 1
		const revision = this.sourceRevision
		this.howler?.unload()
		this.pendingSeek = Math.max(0, finiteNumber(resumeTime))

		const options = {
			html5: true,
			onend: () => {
				if (this.isCurrentRevision(revision)) {
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
					this.callbacks.onError(toPlaybackError(error))
				}
			},
			onpause: () => {
				if (this.isCurrentRevision(revision)) {
					this.callbacks.onPause()
				}
			},
			onplay: () => {
				if (this.isCurrentRevision(revision)) {
					this.callbacks.onPlay()
				}
			},
			onplayerror: (_soundId, error) => {
				if (this.isCurrentRevision(revision)) {
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
			this.howler.play()
		}
		return true
	}

	pause() {
		if (!this.howler) {
			return false
		}
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
		this.howler.seek(Math.min(requestedTime, this.duration))
	}

	changeVolume(value) {
		this.howler?.volume(value)
	}

	changeRate(value) {
		this.howler?.rate(value)
	}

	unloadSource() {
		this.sourceRevision += 1
		this.pendingSeek = null
		this.howler?.unload()
		this.howler = null
	}

	dispose() {
		this.unloadSource()
		this.callbacks = defaultCallbacks
	}

	get currentTime() {
		return finiteNumber(this.howler?.seek())
	}

	get duration() {
		const duration = finiteNumber(this.howler?.duration())
		return duration > 0 ? duration : 0
	}

	applyPendingSeek() {
		if (this.pendingSeek === null) {
			return
		}
		const requestedTime = this.pendingSeek
		this.pendingSeek = null
		if (this.duration > 0) {
			this.howler?.seek(Math.min(requestedTime, this.duration))
		}
	}

	isCurrentRevision(revision) {
		return revision === this.sourceRevision
	}
}

import { Howl } from 'howler'

const defaultOnEnd = () => {
	// Playback can be used without registering an end callback.
}

export class Player {
	constructor({ onEnd } = {}) {
		this.howler = null
		this.onEnd = onEnd || defaultOnEnd
	}

	addUrl(url) {
		this.howler?.unload()
		this.howler = newHowler(url)
		this.howler.once('end', this.onEnd)
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
		this.howler?.pause()
		return true
	}

	seekTo(time) {
		this.howler?.seek(time)
	}

	changeVolume(value) {
		this.howler?.volume(value)
	}

	changeRate(value) {
		this.howler?.rate(value)
	}

	get currentTime() {
		return this.howler?.seek() || 0
	}

	get duration() {
		return this.howler?.duration() || 1
	}
}

const newHowler = (url) =>
	new Howl({
		format: ['mp3'],
		html5: true,
		src: [url],
	})

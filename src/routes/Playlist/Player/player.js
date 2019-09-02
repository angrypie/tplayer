import { Howl } from 'howler'

const defaultOnEnd = () => {}

export class Player {
	constructor({ onEnd } = {}) {
		this.howler = initHowler()
		this.onEnd = onEnd || defaultOnEnd
	}

	addUrl(url) {
		this.howler.unload()
		this.howler = newHowler(url)
		this.howler.once('end', this.onEnd)
	}

	play() {
		if (!this.paused) {
			this.howler.play()
			return true
		}
	}

	pause() {
		if (this.paused) {
			this.howler.pause()
			return true
		}
	}

	seekTo(time) {
		this.howler.seek(time)
	}

	changeVolume(value) {
		this.howler.volume(value)
	}

	changeRate(value) {
		this.howler.rate(value)
	}

	get currentTime() {
		return this.howler.seek() || 0
	}

	get paused() {
		return this.howler.playing()
	}

	get duration() {
		return this.howler.duration() || 1
	}
}

const newHowler = url =>
	new Howl({
		src: [url],
		format: ['mp3'],
		html5: true,
	})

const initHowler = () =>
	newHowler(URL.createObjectURL(new Blob(['0'], { type: 'text/plain' })))

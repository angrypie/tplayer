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
		this.howler.play()
		return true
	}

	pause() {
		this.howler.pause()
		return true
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

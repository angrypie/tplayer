import { Howl, Howler } from 'howler'

export class Player {
	constructor() {
		initHowler()
	}

	addUrl(url) {
		if (this.howler) {
			this.howler.unload()
		}

		this.howler = newHowler(url)
	}

	play() {
		if (this.howler && !this.paused) {
			this.howler.play()
			console.log('test')
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
		Howler.volume(value)
	}

	get currentTime() {
		return this.howler.seek() || 0
	}


	get paused() {
		if (!this.howler) {
			return false
		}
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

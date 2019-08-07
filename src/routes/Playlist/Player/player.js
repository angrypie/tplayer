export class Player {
	constructor() {
		this.audio = new Audio()
	}

	addUrl(url) {
		this.audio = new Audio(url)
	}

	seekTo(time) {
		this.audio.currentTime = time
	}

	get currentTime() {
		return this.audio.currentTime
	}

	play() {
		this.audio.play()
	}

	pause() {
		this.audio.pause()
	}

	get paused() {
		return this.audio.paused
	}
}

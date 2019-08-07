
export class Player {
	constructor() {
		this.audio = new Audio()
	}

	addUrl(url) {
		this.audio = new Audio(url)
	}

	play() {
		this.audio.play()
	}

	pause() {
		this.audio.pause()
	}

	paused() {
		return this.audio.paused
	}

}

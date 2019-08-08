export class Player {
	constructor() {
		this.audio = new Audio()
	}

	addUrl(url) {
		this.audio.src = url
	}

	seekTo(time) {
		this.audio.currentTime = time
	}

	get currentTime() {
		return this.audio.currentTime
	}

	async play() {
		try {
			await this.audio.play()
			return true
		} catch (err) {
			if (err.name === 'NotAllowedError') {
				alert(`Click to 'Play' button to enable autoplay.`)
			}
			return false
		}
	}

	pause() {
		this.audio.pause()
	}

	get paused() {
		return this.audio.paused
	}

	get duration() {
		return this.audio.duration || 1
	}
}

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

	changeVolume(value) {
		this.gainNode.gain.value = value
	}

	get currentTime() {
		return this.audio.currentTime
	}

	async play() {
		this.initContext()
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

	initContext() {
		if (!this.gainNode) {
			var audioCtx = new (window.AudioContext || window.webkitAudioContext)()

			// Create a MediaElementAudioSourceNode
			// Feed the HTMLMediaElement into it
			const source = audioCtx.createMediaElementSource(this.audio)

			// Create a gain node
			const gainNode = audioCtx.createGain()
			source.connect(gainNode)
			gainNode.connect(audioCtx.destination)

			//this.audioCtx = audioCtx
			//this.source = source
			this.gainNode = gainNode
		}
	}
}

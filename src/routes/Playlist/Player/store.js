import { useLocalObservable } from 'mobx-react-lite'
import { Player } from './player'

export const maxVolume = 1
export const rewindStep = 30
export const defaultPlayerState = {
	audio: null,
	player: new Player(),
	playerRef: {},
	playing: false,
	rate: 1,
	volume: 0.7,
}

export const usePlayerStore = () => {
	const store = useLocalObservable(() => ({
		...addState(() => store, defaultPlayerState),

		changeRate(rate) {
			const value = numberOrLimit(rate, 0.5, 4)
			store.setRate(value)
			store.player.changeRate(value)
		},

		changeVolume(volume) {
			store.player.changeVolume(volume)
		},

		getDuration() {
			return store.player.duration
		},

		getProgress() {
			return store.player.currentTime
		},

		//state getters and setters
		newAudio(audio) {
			if (!audio) {
				return false
			}
			const wasPlaying = store.playing
			store.setAudio(audio)
			store.player.addUrl(audio)
			if (wasPlaying) {
				store.play()
			}
			return true
		},

		pause() {
			store.player.pause()
			store.playing = false
		},

		play() {
			store.player.changeRate(store.rate)
			if (store.player.play()) {
				store.playing = true
			}
		},

		seekTo(p) {
			store.player.seekTo(numberOrLimit(Math.round(p), 0, p))
		},

		togglePlaying(isPlaying) {
			const { playing, play, pause } = store
			const shouldPlay = typeof isPlaying === 'boolean' ? isPlaying : !playing
			if (shouldPlay) {
				play()
			} else {
				pause()
			}
		},
	}))

	return store
}

function addState(getStore, state) {
	const props = Object.keys(state)

	return props.reduce((current, prop) => {
		const method = `set${prop[0].toUpperCase() + prop.slice(1)}`
		//init state
		current[prop] = state[prop]
		//defin  setters
		current[method] = (value) => {
			getStore()[prop] = value
		}
		return current
	}, {})
}

//returns 'n' if it betweens 'a' and 'b' limits, or else closest limit.
export const numberOrLimit = (n, a, b) => {
	if (n < a) {
		return a
	}
	if (n > b) {
		return b
	}
	return n
}

import { useLocalObservable } from 'mobx-react-lite'
import { Player } from './player'

export const maxVolume = 1
export const rewindStep = 30
export const defaultPlayerState = {
	volume: 0.7,
	rate: 1,
	audio: null,
	playing: false,
	playerRef: {},
	player: new Player(),
}

export const usePlayerStore = () => {
	const store = useLocalObservable(() => ({
		...addState(() => store, defaultPlayerState),

		seekTo(p) {
			store.player.seekTo(numberOrLimit(Math.round(p), 0, p))
		},

		changeVolume(volume) {
			store.player.changeVolume(volume)
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

		getProgress() {
			return store.player.currentTime
		},

		getDuration() {
			return store.player.duration
		},

		togglePlaying(isPlaying) {
			const { playing, play, pause } = store
			const shouldPlay = typeof isPlaying === 'boolean' ? isPlaying : !playing
			shouldPlay ? play() : pause()
		},

		play() {
			store.player.changeRate(store.rate)
			if (store.player.play()) {
				store.playing = true
			}
		},

		pause() {
			store.player.pause()
			store.playing = false
		},

		changeRate(rate) {
			const value = numberOrLimit(rate, 0.5, 4)
			store.setRate(value)
			store.player.changeRate(value)
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
		current[method] = value => (getStore()[prop] = value)
		return current
	}, {})
}

//returns 'n' if it betweens 'a' and 'b' limits, or else closest limit.
export const numberOrLimit = (n, a, b) => (n < a ? a : n > b ? b : n)

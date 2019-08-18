import { useLocalStore } from 'mobx-react-lite'
import { Player } from './player'

export const maxVolume = 1
export const rewindStep = 30
export const defaultPlayerState = {
	volume: 0.7,
	audio: null,
	playerRef: {},
	player: new Player(),
}

export const usePlayerStore = () => {
	const store = useLocalStore(() => ({
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
			store.setAudio(audio)
			store.player.addUrl(audio)
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
			if (store.player.play()) {
				store.playing = true
			}
		},

		pause() {
			store.player.pause()
			store.playing = false
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

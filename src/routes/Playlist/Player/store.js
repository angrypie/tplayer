import { useLocalStore } from 'mobx-react-lite'
import { Player } from './player'

export const maxVolume = 1
export const rewindStep = 30
export const playerState = {
	duration: 100,
	progress: 0,
	volume: 0.7,
	audio: null,
	playerRef: {},
	player: new Player(),
}

export const usePlayerStore = state => {
	const store = useLocalStore(() => {
		const s = {
			seekTo(p) {
				const player = store.playerRef.current
				return player.seekTo(numberOrLimit(Math.round(p), 0, store.duration))
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

			togglePlaying(isPlaying) {
				const { playing, play, pause } = store
				const shouldPlay = typeof isPlaying === 'boolean' ? isPlaying : !playing
				shouldPlay ? play() : pause()
			},

			play() {
				store.player.play()
				store.playing = true
			},

			pause() {
				store.player.pause()
				store.playing = false
			},
		}
		return addState(s, () => store, playerState)
	})

	return store
}

function addState(current, getStore, state) {
	const props = Object.keys(state)

	return props.reduce((store, prop) => {
		const method = `set${prop[0].toUpperCase() + prop.slice(1)}`
		//init state
		current[prop] = state[prop]
		//defin  setters
		current[method] = value => (getStore()[prop] = value)
		return current
	}, current)
}

//returns 'n' if it betweens 'a' and 'b' limits, or else closest limit.
export const numberOrLimit = (n, a, b) => (n < a ? a : n > b ? b : n)

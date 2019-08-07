import { useLocalStore } from 'mobx-react-lite'

export const maxVolume = 1
export const rewindStep = 30
export const playerState = {
	playing: false,
	duration: 100,
	progress: 0,
	volume: 0.7,
	audio: null,
	playerRef: {},
}

export const usePlayerStore = state => {
	const store = useLocalStore(() => ({
		...state,
		...addSetters(() => store, Object.keys(playerState)),

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
			return true
		},

		togglePlaying(isPlaying) {
			store.setPlaying(
				typeof isPlaying === 'boolean' ? isPlaying : !store.playing
			)
		},
	}))

	return store
}

function addSetters(getStore, props) {
	return props.reduce((store, prop) => {
		const method = `set${prop[0].toUpperCase() + prop.slice(1)}`
		store[method] = value => (getStore()[prop] = value)
		return store
	}, {})
}

//returns 'n' if it betweens 'a' and 'b' limits, or else closest limit.
export const numberOrLimit = (n, a, b) => (n < a ? a : n > b ? b : n)

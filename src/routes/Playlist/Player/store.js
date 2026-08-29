import { useLocalObservable } from 'mobx-react-lite'
import { useState } from 'react'
import { Player } from './player'

export const maxVolume = 1
export const rewindStep = 30

const noOperation = () => undefined
const defaultLifecycleHandlers = {
	onEnd: noOperation,
	onError: noOperation,
	onPause: noOperation,
}

const revokeUrl = (url) => {
	if (typeof url === 'string' && url.length > 0) {
		URL.revokeObjectURL(url)
	}
}

const invokeHandler = (handler, ...arguments_) => {
	try {
		const result = handler(...arguments_)
		if (result instanceof Promise) {
			result.catch(noOperation)
		}
	} catch {
		// Lifecycle callbacks must not break Howler's event dispatch.
	}
}

export const usePlayerStore = () => {
	const [player] = useState(() => new Player())
	const store = useLocalObservable(() => ({
		audio: null,

		changeRate(rate) {
			const value = numberOrLimit(rate, 0.5, 4)
			store.rate = value
			store.player.changeRate(value)
		},

		changeVolume(volume) {
			const value = numberOrLimit(volume, 0, maxVolume)
			store.volume = value
			store.player.changeVolume(value)
		},

		clearSource() {
			revokeUrl(store.audio)
			store.audio = null
			store.error = null
			store.finishPlayback()
			store.loaded = false
			store.loading = false
			player.unloadSource()
		},

		dispose() {
			store.clearSource()
			store.lifecycleHandlers = defaultLifecycleHandlers
			player.dispose()
		},
		error: null,
		finishPlayback() {
			store.playWhenReady = false
			store.playing = false
		},

		getDuration() {
			return Math.max(store.player.duration, 1)
		},

		getProgress() {
			return store.player.currentTime
		},

		handleEnd(playbackState) {
			store.finishPlayback()
			invokeHandler(store.lifecycleHandlers.onEnd, playbackState)
		},

		handleError(error) {
			store.error = error
			store.loading = false
			store.playWhenReady = false
			store.playing = false
			invokeHandler(store.lifecycleHandlers.onError, error)
		},

		handleLoad() {
			store.error = null
			store.loaded = true
			store.loading = false
			if (store.playWhenReady) {
				store.playWhenReady = false
				store.play()
			}
		},

		handlePause() {
			store.playing = false
			invokeHandler(store.lifecycleHandlers.onPause)
		},

		lifecycleHandlers: defaultLifecycleHandlers,
		loaded: false,
		loading: false,

		loadSource({ autoplay = false, format, resumeTime = 0, url }) {
			const shouldPlay = autoplay || store.playing
			revokeUrl(store.audio)
			store.audio = url
			store.error = null
			store.loaded = false
			store.loading = true
			store.playing = false
			store.playWhenReady = shouldPlay
			player.loadSource({
				format,
				rate: store.rate,
				resumeTime,
				url,
				volume: store.volume,
			})
		},

		pause() {
			store.playWhenReady = false
			const willEmitPause = store.player.pause()
			store.playing = false
			if (!willEmitPause) {
				store.handlePause()
			}
		},

		play() {
			store.player.changeRate(store.rate)
			if (store.player.play()) {
				store.playing = true
			}
		},
		player,
		playing: false,

		playWhenReady: false,
		rate: 1,

		seekTo(position) {
			const { duration } = store.player
			const upperLimit = duration > 0 ? duration : Number.MAX_SAFE_INTEGER
			store.player.seekTo(numberOrLimit(position, 0, upperLimit))
		},

		setLifecycleHandlers(handlers = {}) {
			store.lifecycleHandlers = {
				...defaultLifecycleHandlers,
				...handlers,
			}
		},

		setVolume(volume) {
			store.volume = numberOrLimit(volume, 0, maxVolume)
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
		volume: 0.7,
	}))

	player.setCallbacks({
		onEnd: store.handleEnd,
		onError: store.handleError,
		onLoad: store.handleLoad,
		onPause: store.handlePause,
	})

	return store
}

export const numberOrLimit = (number, minimum, maximum) => {
	const numericValue = Number(number)
	if (!Number.isFinite(numericValue)) {
		return minimum
	}
	const lowerLimit = Math.min(minimum, maximum)
	const upperLimit = Math.max(minimum, maximum)
	return Math.min(Math.max(numericValue, lowerLimit), upperLimit)
}

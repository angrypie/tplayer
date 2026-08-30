import { describe, expect, test } from 'bun:test'
import { Player } from './player'

const DURATION_SECONDS = 6 * 60 * 60
const RESTORED_POSITION_SECONDS = 5823
const BACKWARD_SEEK_SECONDS = 5193

const attachFakeHowler = (
	player: Player,
	{ resetToZeroOnPlay = false } = {}
) => {
	let currentTime = RESTORED_POSITION_SECONDS
	let playing = false
	const howler = {
		duration: () => DURATION_SECONDS,
		pause: () => {
			playing = false
		},
		play: () => {
			playing = true
			if (resetToZeroOnPlay) {
				currentTime = 0
			}
		},
		playing: () => playing,
		rate: () => undefined,
		seek: (nextTime?: number) => {
			if (typeof nextTime === 'number') {
				currentTime = nextTime
			}
			return currentTime
		},
		unload: () => undefined,
		volume: () => undefined,
	}
	Reflect.set(player, 'howler', howler)
	return {
		setCurrentTime(nextTime: number) {
			currentTime = nextTime
		},
	}
}

describe('Player progress synchronization', () => {
	test('keeps a restored position visible while playback starts', () => {
		const player = new Player()
		const fakeHowler = attachFakeHowler(player, {
			resetToZeroOnPlay: true,
		})
		expect(player.currentTime).toBe(RESTORED_POSITION_SECONDS)

		expect(player.play()).toBe(true)

		expect(player.currentTime).toBe(RESTORED_POSITION_SECONDS)
		const resumedPosition = RESTORED_POSITION_SECONDS + 0.1
		fakeHowler.setCurrentTime(resumedPosition)
		expect(player.currentTime).toBe(resumedPosition)
		fakeHowler.setCurrentTime(0)
		expect(player.currentTime).toBe(resumedPosition)
	})

	test('does not expose a stale engine position after seeking backward', () => {
		const player = new Player()
		const fakeHowler = attachFakeHowler(player)
		expect(player.currentTime).toBe(RESTORED_POSITION_SECONDS)

		player.seekTo(BACKWARD_SEEK_SECONDS)
		fakeHowler.setCurrentTime(RESTORED_POSITION_SECONDS)

		expect(player.currentTime).toBe(BACKWARD_SEEK_SECONDS)
		fakeHowler.setCurrentTime(BACKWARD_SEEK_SECONDS)
		expect(player.currentTime).toBe(BACKWARD_SEEK_SECONDS)
		fakeHowler.setCurrentTime(RESTORED_POSITION_SECONDS)
		expect(player.currentTime).toBe(BACKWARD_SEEK_SECONDS)
	})

	test('allows the engine to replay from zero after a completed source', () => {
		const player = new Player()
		const fakeHowler = attachFakeHowler(player, {
			resetToZeroOnPlay: true,
		})
		fakeHowler.setCurrentTime(DURATION_SECONDS)
		expect(player.currentTime).toBe(DURATION_SECONDS)

		expect(player.play()).toBe(true)

		expect(player.currentTime).toBe(0)
	})
})

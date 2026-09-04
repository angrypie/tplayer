import { describe, expect, test } from 'bun:test'
import type { TimedWord } from '@tplayer/captions/types'
import { WindowWordStitcher } from './windowStitcher'

const midpoint = (word: TimedWord): number => (word.startMs + word.endMs) / 2

describe('WindowWordStitcher', () => {
	test('aligns multi-token replay and a nearby non-overlapping token once', () => {
		const stitcher = new WindowWordStitcher()
		const prior = [
			{ endMs: 1500, startMs: 1000, text: 'Hello' },
			{ endMs: 89_100, startMs: 88_800, text: 'Foo' },
			{ endMs: 89_500, startMs: 89_200, text: 'Bar' },
			{ endMs: 89_750, startMs: 89_550, text: 'Echo' },
			{ endMs: 90_300, startMs: 89_700, text: 'Exact' },
			{ endMs: 90_300, startMs: 89_950, text: 'Crossed' },
		] satisfies TimedWord[]
		const current = [
			{ endMs: 89_100, startMs: 88_900, text: 'Foo' },
			{ endMs: 89_450, startMs: 89_250, text: 'Bar,' },
			{ endMs: 89_700, startMs: 89_600, text: 'continues' },
			{ endMs: 89_900, startMs: 89_800, text: 'Echo' },
			{ endMs: 90_150, startMs: 89_850, text: 'Exact' },
			{ endMs: 90_000, startMs: 89_900, text: 'Crossed' },
			{ endMs: 93_500, startMs: 93_000, text: 'world.' },
		] satisfies TimedWord[]

		expect(stitcher.pushWindow(prior, 90_000).map((word) => word.text)).toEqual(
			['Hello']
		)
		const ready = stitcher.pushWindow(current, 95_000)
		const all = [...ready, ...stitcher.finish()]
		expect(all.map((word) => word.text)).toEqual([
			'Foo',
			'Bar,',
			'continues',
			'Echo',
			'Exact',
			'Crossed',
			'world.',
		])
		const currentEcho = current.find((word) => word.text === 'Echo')
		const priorEcho = prior.find((word) => word.text === 'Echo')
		if (!(currentEcho && priorEcho)) {
			throw new Error('Echo fixtures were not found')
		}
		expect(currentEcho.startMs - priorEcho.endMs).toBe(50)
	})

	test('recovers a token whose adjacent-window midpoints cross ownership', () => {
		const stitcher = new WindowWordStitcher()
		const prior = { endMs: 90_300, startMs: 89_900, text: 'Crossed' }
		const current = { endMs: 90_000, startMs: 89_750, text: 'Crossed' }
		expect(midpoint(prior)).toBeGreaterThanOrEqual(90_000)
		expect(midpoint(current)).toBeLessThan(90_000)
		expect(stitcher.pushWindow([prior], 90_000)).toEqual([])
		expect(stitcher.pushWindow([current], 95_000)).toEqual([current])
		expect(stitcher.finish()).toEqual([])
	})

	test('preserves a distinct repeated token across the boundary', () => {
		const stitcher = new WindowWordStitcher()
		const first = { endMs: 89_800, startMs: 89_500, text: 'very' }
		const second = { endMs: 90_200, startMs: 89_900, text: 'very' }
		expect(stitcher.pushWindow([first], 90_000)).toEqual([])
		expect(stitcher.pushWindow([second], 95_000)).toEqual([first, second])
	})

	test('normalizes timing jitter behind words already emitted', () => {
		const stitcher = new WindowWordStitcher()
		expect(
			stitcher.pushWindow(
				[{ endMs: 86_500, startMs: 86_000, text: 'before' }],
				90_000
			)
		).toHaveLength(1)
		const [jittered] = stitcher.pushWindow(
			[{ endMs: 86_100, startMs: 85_900, text: 'discovered' }],
			95_000
		)
		expect(jittered?.startMs).toBe(86_000)
		expect(jittered?.endMs).toBe(86_100)
	})
})

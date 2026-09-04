import { describe, expect, test } from 'bun:test'
import { decodeCaptionTrack, encodeCaptionTrack } from '../src/codec'
import { CaptionLookup, createCaptionLookup } from '../src/lookup'

const trackWithGaps = () =>
	decodeCaptionTrack(
		encodeCaptionTrack({
			durationMs: 5000,
			segments: [
				{ endMs: 1000, startMs: 100, text: 'First' },
				{ endMs: 2200, startMs: 1500, text: 'Second' },
				{ endMs: 4000, startMs: 3000, text: 'Third' },
			],
		})
	)

describe('allocation-free caption lookup cursor', () => {
	test('uses start-inclusive and end-exclusive ranges with explicit gaps', () => {
		const lookup = createCaptionLookup(trackWithGaps())
		expect(lookup.seek(99)).toBe(false)
		expect(lookup.index).toBe(-1)

		expect(lookup.seek(100)).toBe(true)
		expect(lookup.index).toBe(0)
		expect(lookup.startMs).toBe(100)
		expect(lookup.endMs).toBe(1000)
		expect(lookup.text).toBe('First')
		expect(lookup.seek(999.999)).toBe(false)
		expect(lookup.index).toBe(0)

		expect(lookup.seek(1000)).toBe(true)
		expect(lookup.index).toBe(-1)
		expect(lookup.text).toBe('')
		expect(lookup.seek(1499)).toBe(false)
		expect(lookup.seek(1500)).toBe(true)
		expect(lookup.text).toBe('Second')
		expect(lookup.seek(2200)).toBe(true)
		expect(lookup.index).toBe(-1)
	})

	test('handles sequential playback, large seeks, and backward seeks on one cursor', () => {
		const lookup = new CaptionLookup(trackWithGaps())
		const samples = [100, 200, 1600, 3500, 3200, 1700, 500, 4999]
		const expected = [0, 0, 1, 2, 2, 1, 0, -1]
		const observed: number[] = []
		for (const sample of samples) {
			lookup.seek(sample)
			observed.push(lookup.index)
		}
		expect(observed).toEqual(expected)
	})

	test('treats invalid media times as no active caption', () => {
		const lookup = createCaptionLookup(trackWithGaps())
		lookup.seek(500)
		for (const invalid of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(lookup.seek(invalid)).toBe(true)
			expect(lookup.index).toBe(-1)
			lookup.seek(500)
		}
	})

	test('reset mutates the existing cursor only when its visible state changes', () => {
		const lookup = createCaptionLookup(trackWithGaps())
		expect(lookup.reset()).toBe(false)
		lookup.seek(3100)
		expect(lookup.reset()).toBe(true)
		expect(lookup.index).toBe(-1)
		expect(lookup.startMs).toBe(0)
		expect(lookup.endMs).toBe(0)
		expect(lookup.text).toBe('')
		expect(lookup.reset()).toBe(false)
	})

	test('keeps an empty track inactive for every query', () => {
		const track = decodeCaptionTrack(encodeCaptionTrack({ segments: [] }))
		const lookup = createCaptionLookup(track)
		for (const timeMs of [0, 1, 10_000]) {
			expect(lookup.seek(timeMs)).toBe(false)
			expect(lookup.index).toBe(-1)
		}
	})
})

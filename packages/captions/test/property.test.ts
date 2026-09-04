import { describe, expect, test } from 'bun:test'
import { decodeCaptionTrack, encodeCaptionTrack } from '../src/codec'
import { createCaptionLookup } from '../src/lookup'
import { segmentTimedWords } from '../src/segmenter'
import type { CaptionSegment, TimedWord } from '../src/types'

const RANDOM_SEEDS = 80
const QUERIES_PER_SEED = 120
const WORDS_PER_SEED = 240
const TEXT_FRAGMENTS = [
	'alpha',
	'βήτα',
	'café',
	'世界',
	'emoji-🎧',
	'question?',
	'pause.',
] as const

class DeterministicRandom {
	private state: number

	constructor(seed: number) {
		this.state = Math.max(1, Math.trunc(seed) % 2_147_483_647)
	}

	integer(maximumExclusive: number): number {
		this.state = (this.state * 48_271) % 2_147_483_647
		return this.state % maximumExclusive
	}
}

const makeWords = (seed: number): TimedWord[] => {
	const random = new DeterministicRandom(seed)
	const words: TimedWord[] = []
	let cursorMs = 0
	for (let index = 0; index < WORDS_PER_SEED; index += 1) {
		const gapMs = random.integer(900)
		const durationMs = 80 + random.integer(520)
		const startMs = cursorMs + gapMs
		const text = TEXT_FRAGMENTS[random.integer(TEXT_FRAGMENTS.length)]
		if (text === undefined) {
			throw new Error('Deterministic text fixture is missing')
		}
		words.push({
			confidence: random.integer(101) / 100,
			endMs: startMs + durationMs,
			startMs,
			text,
		})
		cursorMs = startMs + durationMs
	}
	return words
}

const linearLookup = (
	segments: readonly CaptionSegment[],
	timeMs: number
): number =>
	segments.findIndex(
		(segment) => segment.startMs <= timeMs && timeMs < segment.endMs
	)

describe('deterministic randomized caption invariants', () => {
	test('round-trips generated tracks and matches a linear lookup oracle', () => {
		for (let seed = 1; seed <= RANDOM_SEEDS; seed += 1) {
			const random = new DeterministicRandom(seed * 17)
			const segments = segmentTimedWords(makeWords(seed))
			const durationMs = (segments.at(-1)?.endMs ?? 0) + random.integer(5000)
			const encoded = encodeCaptionTrack({ durationMs, segments })
			expect(encoded).toEqual(encodeCaptionTrack({ durationMs, segments }))
			const track = decodeCaptionTrack(encoded)
			expect(track.segmentCount).toBe(segments.length)
			for (const [index, segment] of segments.entries()) {
				expect(track.startMsAt(index)).toBe(segment.startMs)
				expect(track.endMsAt(index)).toBe(segment.endMs)
				expect(track.textAt(index)).toBe(segment.text)
			}

			const lookup = createCaptionLookup(track)
			for (let query = 0; query < QUERIES_PER_SEED; query += 1) {
				const timeMs = random.integer(Math.max(1, durationMs + 1000))
				lookup.seek(timeMs)
				expect(lookup.index).toBe(linearLookup(segments, timeMs))
			}
		}
	})

	test('always emits positive, sorted, non-overlapping display segments', () => {
		for (let seed = 101; seed < 101 + RANDOM_SEEDS; seed += 1) {
			const segments = segmentTimedWords(makeWords(seed))
			let previousEndMs = 0
			for (const [index, segment] of segments.entries()) {
				expect(segment.endMs).toBeGreaterThan(segment.startMs)
				if (index > 0) {
					expect(segment.startMs).toBeGreaterThanOrEqual(previousEndMs)
				}
				expect(segment.text.trim()).toBe(segment.text)
				previousEndMs = segment.endMs
			}
			expect(() =>
				decodeCaptionTrack(encodeCaptionTrack({ segments }))
			).not.toThrow()
		}
	})
})

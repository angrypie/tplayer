import { describe, expect, test } from 'bun:test'
import {
	CaptionSegmentationError,
	CaptionSegmenter,
	DEFAULT_CAPTION_SEGMENTATION_OPTIONS,
	segmentTimedWords,
} from '../src/segmenter'
import type { TimedWord } from '../src/types'

const BACKWARD_PATTERN = /must not precede/
const CONFIDENCE_PATTERN = /confidence/
const EMPTY_TEXT_PATTERN = /must not be empty/
const FINISHED_PATTERN = /Cannot push words/
const INTEGER_PATTERN = /integer/
const ORDER_PATTERN = /non-decreasing/

const wordsFrom = (
	texts: readonly string[],
	startMs = 0,
	stepMs = 500,
	durationMs = 300
): TimedWord[] =>
	texts.map((text, index) => ({
		endMs: startMs + index * stepMs + durationMs,
		startMs: startMs + index * stepMs,
		text,
	}))

describe('caption segmenter', () => {
	test('returns no segments for silence', () => {
		expect(segmentTimedWords([])).toEqual([])
	})

	test('normalizes word whitespace and renders punctuation without artificial spaces', () => {
		const words = wordsFrom(['  He\nllo  ', ',', '“', 'quoted', 'world.', '”'])
		const [segment] = segmentTimedWords(words, {
			maxDurationMs: 10_000,
			minimumSegmentDurationMs: 10_000,
		})
		expect(segment).toEqual({
			endMs: 3150,
			startMs: 0,
			text: 'He llo, “quoted world.”',
		})
	})

	test('splits at a sentence boundary once the minimum display duration is met', () => {
		const segments = segmentTimedWords(
			[
				{ endMs: 400, startMs: 0, text: 'A' },
				{ endMs: 1400, startMs: 900, text: 'sentence.' },
				{ endMs: 2100, startMs: 1800, text: 'Next' },
			],
			{ lingerMs: 500 }
		)
		expect(segments).toEqual([
			{ endMs: 1800, startMs: 0, text: 'A sentence.' },
			{ endMs: 2600, startMs: 1800, text: 'Next' },
		])
	})

	test('keeps a separate closing quote with the sentence it closes', () => {
		const segments = segmentTimedWords([
			{ endMs: 400, startMs: 0, text: '“Opening' },
			{ endMs: 1300, startMs: 800, text: 'sentence.' },
			{ endMs: 1400, startMs: 1350, text: '”' },
			{ endMs: 2200, startMs: 1800, text: 'Next' },
		])
		expect(segments[0]?.text).toBe('“Opening sentence.”')
		expect(segments[1]?.text).toBe('Next')
	})

	test('splits on silence and clips linger before the next caption', () => {
		const segments = segmentTimedWords(
			[
				{ endMs: 300, startMs: 0, text: 'Before' },
				{ endMs: 1700, startMs: 1400, text: 'after' },
			],
			{ lingerMs: 2000, maxGapMs: 900 }
		)
		expect(segments).toEqual([
			{ endMs: 1400, startMs: 0, text: 'Before' },
			{ endMs: 3700, startMs: 1400, text: 'after' },
		])
	})

	test('honors word, character, and duration ceilings at deterministic boundaries', () => {
		const byWords = segmentTimedWords(wordsFrom(['one', 'two', 'three']), {
			lingerMs: 0,
			maxWords: 2,
			minimumSegmentDurationMs: 10_000,
		})
		expect(byWords.map(({ text }) => text)).toEqual(['one two', 'three'])

		const byCharacters = segmentTimedWords(wordsFrom(['abcd', 'efgh']), {
			lingerMs: 0,
			maxCharacters: 8,
			minimumSegmentDurationMs: 10_000,
		})
		expect(byCharacters.map(({ text }) => text)).toEqual(['abcd', 'efgh'])

		const byDuration = segmentTimedWords(
			[
				{ endMs: 300, startMs: 0, text: 'short' },
				{ endMs: 1700, startMs: 1200, text: 'late' },
			],
			{
				lingerMs: 0,
				maxDurationMs: 1000,
				maxGapMs: 5000,
				minimumSegmentDurationMs: 10_000,
			}
		)
		expect(byDuration.map(({ text }) => text)).toEqual(['short', 'late'])
	})

	test('incremental and convenience APIs produce identical immutable snapshots', () => {
		const words = wordsFrom(['one', 'two.', 'three', 'four'])
		const segmenter = new CaptionSegmenter()
		for (const word of words) {
			segmenter.push(word)
		}
		const first = segmenter.finish()
		first.length = 0
		expect(segmenter.finish()).toEqual(segmentTimedWords(words))
		expect(() => segmenter.push(words[0] as TimedWord)).toThrow(
			FINISHED_PATTERN
		)
	})

	test('accepts overlapping word ends while preserving ordered non-overlapping captions', () => {
		const segments = segmentTimedWords(
			[
				{ endMs: 1000, startMs: 0, text: 'overlap' },
				{ endMs: 1200, startMs: 800, text: 'inside' },
				{ endMs: 1800, startMs: 1500, text: 'next' },
			],
			{ lingerMs: 1000, maxWords: 2 }
		)
		expect(segments).toEqual([
			{ endMs: 1500, startMs: 0, text: 'overlap inside' },
			{ endMs: 2800, startMs: 1500, text: 'next' },
		])
	})

	test('validates options and malformed timed words', () => {
		expect(DEFAULT_CAPTION_SEGMENTATION_OPTIONS.maxWords).toBe(14)
		expect(() => new CaptionSegmenter({ maxWords: 0 })).toThrow(
			CaptionSegmentationError
		)
		expect(() => new CaptionSegmenter({ lingerMs: 1.5 })).toThrow(
			INTEGER_PATTERN
		)
		expect(() =>
			segmentTimedWords([{ endMs: 1, startMs: 0, text: '  ' }])
		).toThrow(EMPTY_TEXT_PATTERN)
		expect(() =>
			segmentTimedWords([{ endMs: 0, startMs: 1, text: 'backward' }])
		).toThrow(BACKWARD_PATTERN)
		expect(() =>
			segmentTimedWords([
				{ endMs: 20, startMs: 10, text: 'later' },
				{ endMs: 10, startMs: 0, text: 'earlier' },
			])
		).toThrow(ORDER_PATTERN)
		expect(() =>
			segmentTimedWords([
				{ confidence: 1.01, endMs: 1, startMs: 0, text: 'uncertain' },
			])
		).toThrow(CONFIDENCE_PATTERN)
	})
})

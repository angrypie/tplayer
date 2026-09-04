import type { CaptionSegment, TimedWord } from './types'

export interface CaptionSegmentationOptions {
	readonly lingerMs?: number
	readonly maxCharacters?: number
	readonly maxDurationMs?: number
	readonly maxGapMs?: number
	readonly maxWords?: number
	readonly minimumSegmentDurationMs?: number
}

interface ResolvedCaptionSegmentationOptions {
	readonly lingerMs: number
	readonly maxCharacters: number
	readonly maxDurationMs: number
	readonly maxGapMs: number
	readonly maxWords: number
	readonly minimumSegmentDurationMs: number
}

interface DraftSegment {
	endMs: number
	startMs: number
	text: string
	wordCount: number
}

export const DEFAULT_CAPTION_SEGMENTATION_OPTIONS = Object.freeze({
	lingerMs: 350,
	maxCharacters: 84,
	maxDurationMs: 6000,
	maxGapMs: 900,
	maxWords: 14,
	minimumSegmentDurationMs: 1000,
}) satisfies Readonly<ResolvedCaptionSegmentationOptions>

const MAXIMUM_UINT32 = 0xff_ff_ff_ff
const SENTENCE_END_PATTERN = /[.!?…]["'’”\])}]*$/u
const NO_SPACE_BEFORE_PATTERN = /^[,.;:!?%…\])}”’]/u
const NO_SPACE_AFTER_PATTERN = /[([{“‘]$/u
const CLOSING_PUNCTUATION_PATTERN = /^["'’”\])}]+$/u
const WHITESPACE_PATTERN = /\s+/gu

export class CaptionSegmentationError extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'CaptionSegmentationError'
	}
}

export class CaptionSegmenter {
	private current: DraftSegment | null = null
	private previousWordStartMs = -1
	private readonly resolvedOptions: ResolvedCaptionSegmentationOptions
	private readonly segments: CaptionSegment[] = []
	private readonly state: { boundaryRequested: boolean; finished: boolean } = {
		boundaryRequested: false,
		finished: false,
	}

	constructor(options: CaptionSegmentationOptions = {}) {
		this.resolvedOptions = resolveOptions(options)
	}

	push(word: TimedWord): void {
		if (this.state.finished) {
			throw new CaptionSegmentationError(
				'Cannot push words after the segmenter is finished'
			)
		}
		const normalized = normalizeWord(word, this.previousWordStartMs)
		this.previousWordStartMs = normalized.startMs
		if (this.shouldFlushBefore(normalized)) {
			this.flush(normalized.startMs)
		}
		this.append(normalized)
		this.state.boundaryRequested =
			SENTENCE_END_PATTERN.test(normalized.text) ||
			(this.state.boundaryRequested &&
				CLOSING_PUNCTUATION_PATTERN.test(normalized.text))
	}

	finish(): CaptionSegment[] {
		if (!this.state.finished) {
			this.flush()
			this.state.finished = true
		}
		return this.segments.slice()
	}

	private append(word: TimedWord): void {
		if (!this.current) {
			this.current = {
				endMs: word.endMs,
				startMs: word.startMs,
				text: word.text,
				wordCount: 1,
			}
			return
		}
		this.current.endMs = Math.max(this.current.endMs, word.endMs)
		this.current.text = appendWord(this.current.text, word.text)
		this.current.wordCount += 1
	}

	private flush(nextStartMs?: number): void {
		const { current } = this
		if (!current) {
			return
		}
		const naturalEndMs = Math.min(
			MAXIMUM_UINT32,
			Math.max(
				current.startMs + 1,
				current.endMs + this.resolvedOptions.lingerMs
			)
		)
		const endMs =
			nextStartMs === undefined
				? naturalEndMs
				: Math.min(naturalEndMs, nextStartMs)
		if (endMs <= current.startMs) {
			throw new CaptionSegmentationError(
				'Caption words cannot form a positive, non-overlapping segment'
			)
		}
		this.segments.push({
			endMs,
			startMs: current.startMs,
			text: current.text,
		})
		this.current = null
		this.state.boundaryRequested = false
	}

	private shouldFlushBefore(word: TimedWord): boolean {
		const { current } = this
		if (!current || word.startMs <= current.startMs) {
			return false
		}
		const gapMs = Math.max(0, word.startMs - current.endMs)
		const candidateText = appendWord(current.text, word.text)
		const candidateDurationMs =
			Math.max(current.endMs, word.endMs) - current.startMs
		const reachedSentenceBoundary =
			this.state.boundaryRequested &&
			!CLOSING_PUNCTUATION_PATTERN.test(word.text) &&
			current.endMs - current.startMs >=
				this.resolvedOptions.minimumSegmentDurationMs
		return (
			gapMs >= this.resolvedOptions.maxGapMs ||
			current.wordCount >= this.resolvedOptions.maxWords ||
			candidateText.length > this.resolvedOptions.maxCharacters ||
			candidateDurationMs > this.resolvedOptions.maxDurationMs ||
			reachedSentenceBoundary
		)
	}
}

export const segmentTimedWords = (
	words: readonly TimedWord[],
	options: CaptionSegmentationOptions = {}
): CaptionSegment[] => {
	const segmenter = new CaptionSegmenter(options)
	for (const word of words) {
		segmenter.push(word)
	}
	return segmenter.finish()
}

const appendWord = (current: string, next: string): string => {
	if (
		NO_SPACE_BEFORE_PATTERN.test(next) ||
		NO_SPACE_AFTER_PATTERN.test(current)
	) {
		return `${current}${next}`
	}
	return `${current} ${next}`
}

const assertOption = (
	value: number,
	name: keyof ResolvedCaptionSegmentationOptions,
	minimum: number
): void => {
	if (!Number.isSafeInteger(value) || value < minimum) {
		throw new CaptionSegmentationError(
			`${name} must be an integer greater than or equal to ${minimum}`
		)
	}
}

const normalizeWord = (
	word: TimedWord,
	previousWordStartMs: number
): TimedWord => {
	if (typeof word.text !== 'string') {
		throw new CaptionSegmentationError('Timed word text must be a string')
	}
	const text = word.text.trim().replace(WHITESPACE_PATTERN, ' ')
	if (text.length === 0) {
		throw new CaptionSegmentationError('Timed word text must not be empty')
	}
	assertWordTimestamp(word.startMs, 'startMs')
	assertWordTimestamp(word.endMs, 'endMs')
	if (word.endMs < word.startMs) {
		throw new CaptionSegmentationError(
			'Timed word endMs must not precede startMs'
		)
	}
	if (word.startMs < previousWordStartMs) {
		throw new CaptionSegmentationError(
			'Timed words must be ordered by non-decreasing startMs'
		)
	}
	if (
		word.confidence !== undefined &&
		word.confidence !== null &&
		(!Number.isFinite(word.confidence) ||
			word.confidence < 0 ||
			word.confidence > 1)
	) {
		throw new CaptionSegmentationError(
			'Timed word confidence must be between 0 and 1'
		)
	}
	return {
		...(word.confidence === undefined ? {} : { confidence: word.confidence }),
		endMs: word.endMs,
		startMs: word.startMs,
		text,
	}
}

const assertWordTimestamp = (value: number, name: string): void => {
	if (!Number.isSafeInteger(value) || value < 0 || value > MAXIMUM_UINT32) {
		throw new CaptionSegmentationError(
			`Timed word ${name} must be an unsigned 32-bit integer`
		)
	}
}

const resolveOptions = ({
	lingerMs = DEFAULT_CAPTION_SEGMENTATION_OPTIONS.lingerMs,
	maxCharacters = DEFAULT_CAPTION_SEGMENTATION_OPTIONS.maxCharacters,
	maxDurationMs = DEFAULT_CAPTION_SEGMENTATION_OPTIONS.maxDurationMs,
	maxGapMs = DEFAULT_CAPTION_SEGMENTATION_OPTIONS.maxGapMs,
	maxWords = DEFAULT_CAPTION_SEGMENTATION_OPTIONS.maxWords,
	minimumSegmentDurationMs = DEFAULT_CAPTION_SEGMENTATION_OPTIONS.minimumSegmentDurationMs,
}: CaptionSegmentationOptions): ResolvedCaptionSegmentationOptions => {
	assertOption(lingerMs, 'lingerMs', 0)
	assertOption(maxCharacters, 'maxCharacters', 1)
	assertOption(maxDurationMs, 'maxDurationMs', 1)
	assertOption(maxGapMs, 'maxGapMs', 0)
	assertOption(maxWords, 'maxWords', 1)
	assertOption(minimumSegmentDurationMs, 'minimumSegmentDurationMs', 0)
	return {
		lingerMs,
		maxCharacters,
		maxDurationMs,
		maxGapMs,
		maxWords,
		minimumSegmentDurationMs,
	}
}

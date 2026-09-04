import type { TimedWord } from '@tplayer/captions/types'

const ALIGNMENT_MATCH_REWARD = 1_000_000
const MAXIMUM_ALIGNMENT_HEAD_WORDS = 48
const MAXIMUM_STITCH_TAIL_WORDS = 48
const STITCH_ALIGNMENT_TOLERANCE_MS = 400
const STITCH_TAIL_DURATION_MS = 3000
const TOKEN_EDGE_PATTERN = /^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu

const ALIGNMENT_DIRECTION = {
	diagonal: 3,
	left: 2,
	up: 1,
} as const

const comparableToken = (text: string): string => {
	const normalized = text
		.normalize('NFKC')
		.trim()
		.toLocaleLowerCase()
		.replace(TOKEN_EDGE_PATTERN, '')
	return normalized || text
}

const wordGap = (left: TimedWord, right: TimedWord): number =>
	Math.max(
		0,
		Math.max(left.startMs, right.startMs) - Math.min(left.endMs, right.endMs)
	)

const wordOverlap = (left: TimedWord, right: TimedWord): number =>
	Math.max(
		0,
		Math.min(left.endMs, right.endMs) - Math.max(left.startMs, right.startMs)
	)

const midpointDistance = (left: TimedWord, right: TimedWord): number =>
	Math.abs((left.startMs + left.endMs - right.startMs - right.endMs) / 2)

const compareWords = (left: TimedWord, right: TimedWord): number =>
	left.startMs - right.startMs || left.endMs - right.endMs

const canAlign = (left: TimedWord, right: TimedWord): boolean =>
	comparableToken(left.text) === comparableToken(right.text) &&
	wordGap(left, right) <= STITCH_ALIGNMENT_TOLERANCE_MS

interface AlignmentPair {
	current: TimedWord
	priorIndex: number
}

interface AlignmentMatrix {
	columns: number
	directions: Uint8Array
}

const overlapHead = (
	prior: readonly TimedWord[],
	current: readonly TimedWord[]
): TimedWord[] => {
	const earliestPriorStart = prior[0]?.startMs ?? 0
	const latestPriorEnd = prior.reduce(
		(latest, word) => Math.max(latest, word.endMs),
		0
	)
	return current
		.filter(
			(word) =>
				word.endMs >= earliestPriorStart - STITCH_ALIGNMENT_TOLERANCE_MS &&
				word.startMs <= latestPriorEnd + STITCH_ALIGNMENT_TOLERANCE_MS
		)
		.slice(0, MAXIMUM_ALIGNMENT_HEAD_WORDS)
}

const buildAlignmentMatrix = (
	prior: readonly TimedWord[],
	current: readonly TimedWord[]
): AlignmentMatrix => {
	const columns = current.length + 1
	const rows = prior.length + 1
	const scores = new Float64Array(rows * columns)
	const directions = new Uint8Array(rows * columns)
	for (let priorIndex = 1; priorIndex < rows; priorIndex += 1) {
		for (let currentIndex = 1; currentIndex < columns; currentIndex += 1) {
			const index = priorIndex * columns + currentIndex
			const upScore = scores[index - columns] ?? 0
			const leftScore = scores[index - 1] ?? 0
			if (upScore >= leftScore) {
				scores[index] = upScore
				directions[index] = ALIGNMENT_DIRECTION.up
			} else {
				scores[index] = leftScore
				directions[index] = ALIGNMENT_DIRECTION.left
			}
			const priorWord = prior[priorIndex - 1]
			const currentWord = current[currentIndex - 1]
			if (!(priorWord && currentWord && canAlign(priorWord, currentWord))) {
				continue
			}
			const diagonalScore =
				(scores[index - columns - 1] ?? 0) +
				ALIGNMENT_MATCH_REWARD -
				midpointDistance(priorWord, currentWord)
			if (diagonalScore >= (scores[index] ?? 0)) {
				scores[index] = diagonalScore
				directions[index] = ALIGNMENT_DIRECTION.diagonal
			}
		}
	}
	return { columns, directions }
}

const traceAlignment = (
	priorLength: number,
	current: readonly TimedWord[],
	matrix: AlignmentMatrix
): AlignmentPair[] => {
	const reversed: AlignmentPair[] = []
	let priorIndex = priorLength
	let currentIndex = current.length
	while (priorIndex > 0 && currentIndex > 0) {
		const direction =
			matrix.directions[priorIndex * matrix.columns + currentIndex]
		if (direction === ALIGNMENT_DIRECTION.diagonal) {
			const currentWord = current[currentIndex - 1]
			if (currentWord) {
				reversed.push({ current: currentWord, priorIndex: priorIndex - 1 })
			}
			priorIndex -= 1
			currentIndex -= 1
		} else if (direction === ALIGNMENT_DIRECTION.left) {
			currentIndex -= 1
		} else {
			priorIndex -= 1
		}
	}
	return reversed.reverse()
}

/**
 * Finds a one-to-one, order-preserving token alignment between adjacent ASR
 * windows. A dynamic alignment avoids matching one prior token to multiple
 * repeated tokens in the next window.
 */
const alignWindowOverlap = (
	prior: readonly TimedWord[],
	current: readonly TimedWord[]
): AlignmentPair[] => {
	if (prior.length === 0 || current.length === 0) {
		return []
	}
	const head = overlapHead(prior, current)
	if (head.length === 0) {
		return []
	}
	return traceAlignment(prior.length, head, buildAlignmentMatrix(prior, head))
}

const replayedPriorIndices = (
	prior: readonly TimedWord[],
	current: readonly TimedWord[]
): Set<number> => {
	const alignment = alignWindowOverlap(prior, current)
	if (alignment.length > 1) {
		return new Set(alignment.map((pair) => pair.priorIndex))
	}
	const [single] = alignment
	if (!single) {
		return new Set()
	}
	const priorWord = prior[single.priorIndex]
	return priorWord && wordOverlap(priorWord, single.current) > 0
		? new Set([single.priorIndex])
		: new Set()
}

/**
 * Reconciles raw overlapping tails from sequential speech-recognition windows
 * before emitting words to the caption segmenter. The delayed tail is bounded
 * and small, while older words stream through immediately.
 */
export class WindowWordStitcher {
	private lastEmitted: TimedWord | undefined
	private pendingTail: TimedWord[] = []

	finish(): TimedWord[] {
		const words = this.normalize(this.pendingTail)
		this.pendingTail = []
		return words
	}

	pushWindow(words: readonly TimedWord[], logicalEndMs: number): TimedWord[] {
		const current = words.slice().sort(compareWords)
		const replayed = replayedPriorIndices(this.pendingTail, current)
		const merged = [
			...this.pendingTail.filter((_word, index) => !replayed.has(index)),
			...current,
		].sort(compareWords)
		const cutoffMs = logicalEndMs - STITCH_TAIL_DURATION_MS
		const ready: TimedWord[] = []
		const nextTail: TimedWord[] = []
		for (const word of merged) {
			if (word.endMs < cutoffMs) {
				ready.push(word)
			} else {
				nextTail.push(word)
			}
		}
		const overflow = Math.max(0, nextTail.length - MAXIMUM_STITCH_TAIL_WORDS)
		if (overflow > 0) {
			ready.push(...nextTail.slice(0, overflow))
		}
		this.pendingTail = nextTail.slice(overflow)
		return this.normalize(ready)
	}

	private normalize(words: readonly TimedWord[]): TimedWord[] {
		const normalized: TimedWord[] = []
		for (const word of words) {
			const previous = this.lastEmitted
			const stitched =
				previous && word.startMs < previous.startMs
					? {
							...(word.confidence === undefined
								? {}
								: { confidence: word.confidence }),
							endMs: Math.max(previous.startMs + 1, word.endMs),
							startMs: previous.startMs,
							text: word.text,
						}
					: word
			normalized.push(stitched)
			this.lastEmitted = stitched
		}
		return normalized
	}
}

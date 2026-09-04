export interface TimedWord {
	readonly confidence?: number | null
	readonly endMs: number
	readonly startMs: number
	readonly text: string
}

export interface CaptionSegment {
	readonly endMs: number
	readonly startMs: number
	readonly text: string
}

export interface CaptionTrackInput {
	readonly durationMs?: number
	readonly segments: readonly CaptionSegment[]
}

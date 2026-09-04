import type { CaptionTrack } from './codec'

export class CaptionLookup {
	private currentEndMs = 0
	private currentIndex = -1
	private currentStartMs = 0
	private currentText = ''
	private readonly track: CaptionTrack

	constructor(track: CaptionTrack) {
		this.track = track
	}

	get endMs(): number {
		return this.currentEndMs
	}

	get index(): number {
		return this.currentIndex
	}

	get startMs(): number {
		return this.currentStartMs
	}

	get text(): string {
		return this.currentText
	}

	reset(): boolean {
		return this.select(-1)
	}

	seek(timeMs: number): boolean {
		return this.select(this.findIndex(timeMs))
	}

	private findIndex(timeMs: number): number {
		if (
			!Number.isFinite(timeMs) ||
			timeMs < 0 ||
			this.track.segmentCount === 0
		) {
			return -1
		}
		const current = this.currentIndex
		if (current >= 0 && this.contains(current, timeMs)) {
			return current
		}
		const next = current + 1
		if (
			next >= 0 &&
			next < this.track.segmentCount &&
			this.contains(next, timeMs)
		) {
			return next
		}
		const previous = current - 1
		if (previous >= 0 && this.contains(previous, timeMs)) {
			return previous
		}

		let lower = 0
		let upper = this.track.segmentCount - 1
		let candidate = -1
		while (lower <= upper) {
			const middle = lower + Math.floor((upper - lower) / 2)
			if (this.track.startMsAt(middle) <= timeMs) {
				candidate = middle
				lower = middle + 1
			} else {
				upper = middle - 1
			}
		}
		return candidate >= 0 && this.contains(candidate, timeMs) ? candidate : -1
	}

	private contains(index: number, timeMs: number): boolean {
		return (
			this.track.startMsAt(index) <= timeMs &&
			timeMs < this.track.endMsAt(index)
		)
	}

	private select(index: number): boolean {
		if (index === this.currentIndex) {
			return false
		}
		this.currentIndex = index
		if (index < 0) {
			this.currentStartMs = 0
			this.currentEndMs = 0
			this.currentText = ''
			return true
		}
		this.currentStartMs = this.track.startMsAt(index)
		this.currentEndMs = this.track.endMsAt(index)
		this.currentText = this.track.textAt(index)
		return true
	}
}

export const createCaptionLookup = (track: CaptionTrack): CaptionLookup =>
	new CaptionLookup(track)

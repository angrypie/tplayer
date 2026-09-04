import { fullGC, heapStats } from 'bun:jsc'
import { expect, test } from 'bun:test'
import { decodeCaptionTrack, encodeCaptionTrack } from '../src/codec'
import { createCaptionLookup } from '../src/lookup'
import type { CaptionSegment } from '../src/types'

const HOURS = 12
const SEGMENT_DURATION_MS = 4200
const SEGMENT_PERIOD_MS = 6000
const TRACK_DURATION_MS = HOURS * 60 * 60 * 1000
const LOOKUP_QUERIES = 1_000_000
const LOOKUP_WARMUP_QUERIES = 100_000
const MAXIMUM_RETAINED_HEAP_BYTES = 64 * 1024
const MAXIMUM_RETAINED_OBJECTS = 256

interface HeapSample {
	heapSize: number
	objectCount: number
}

const collectHeapSample = (): HeapSample => {
	fullGC()
	const sample = heapStats()
	return {
		heapSize: sample.heapSize,
		objectCount: sample.objectCount,
	}
}

const benchmarkSegments = (): CaptionSegment[] => {
	const segments: CaptionSegment[] = []
	for (
		let startMs = 0, index = 0;
		startMs < TRACK_DURATION_MS;
		startMs += SEGMENT_PERIOD_MS, index += 1
	) {
		segments.push({
			endMs: startMs + SEGMENT_DURATION_MS,
			startMs,
			text: `Measured caption ${index}: the quick audiobook listener follows every spoken phrase.`,
		})
	}
	return segments
}

test('caption lookup performance handles a twelve-hour track within a bounded hot-path budget', () => {
	const segments = benchmarkSegments()
	const jsonBytes = new TextEncoder().encode(
		JSON.stringify({ segments })
	).byteLength

	const encodeStartedAt = performance.now()
	const encoded = encodeCaptionTrack({
		durationMs: TRACK_DURATION_MS,
		segments,
	})
	const encodeMilliseconds = performance.now() - encodeStartedAt

	const decodeStartedAt = performance.now()
	const track = decodeCaptionTrack(encoded)
	const decodeMilliseconds = performance.now() - decodeStartedAt
	const lookup = createCaptionLookup(track)
	for (let index = 0; index < track.segmentCount; index += 1) {
		track.textAt(index)
	}
	for (let query = 0; query < LOOKUP_WARMUP_QUERIES; query += 1) {
		lookup.seek((query * 137) % TRACK_DURATION_MS)
	}
	const heapBefore = collectHeapSample()

	let checksum = 0
	const lookupStartedAt = performance.now()
	for (let query = 0; query < LOOKUP_QUERIES; query += 1) {
		const sequentialTime = (query * 137) % TRACK_DURATION_MS
		lookup.seek(sequentialTime)
		checksum += lookup.index
	}
	const lookupMilliseconds = performance.now() - lookupStartedAt
	const lookupsPerSecond = LOOKUP_QUERIES / (lookupMilliseconds / 1000)
	const heapAfter = collectHeapSample()
	const retainedHeapBytes = Math.max(
		0,
		heapAfter.heapSize - heapBefore.heapSize
	)
	const retainedObjects = Math.max(
		0,
		heapAfter.objectCount - heapBefore.objectCount
	)

	expect(track.segmentCount).toBe(segments.length)
	expect(checksum).not.toBe(0)
	expect(encoded.byteLength).toBeLessThan(jsonBytes)
	expect(encodeMilliseconds).toBeLessThan(2000)
	expect(decodeMilliseconds).toBeLessThan(2000)
	expect(lookupMilliseconds).toBeLessThan(5000)
	expect(lookupsPerSecond).toBeGreaterThan(100_000)
	expect(retainedHeapBytes).toBeLessThanOrEqual(MAXIMUM_RETAINED_HEAP_BYTES)
	expect(retainedObjects).toBeLessThanOrEqual(MAXIMUM_RETAINED_OBJECTS)

	process.stdout.write(
		`BENCHMARK ${JSON.stringify({
			binaryBytes: encoded.byteLength,
			decodeMilliseconds: Number(decodeMilliseconds.toFixed(2)),
			encodeMilliseconds: Number(encodeMilliseconds.toFixed(2)),
			jsonBytes,
			lookupMilliseconds: Number(lookupMilliseconds.toFixed(2)),
			lookups: LOOKUP_QUERIES,
			lookupsPerSecond: Math.round(lookupsPerSecond),
			name: 'caption-lookup-12h',
			retainedHeapBytes,
			retainedObjects,
			segments: segments.length,
		})}\n`
	)
}, 10_000)

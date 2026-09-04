import { describe, expect, test } from 'bun:test'
import {
	CAPTION_FILE_EXTENSION,
	CAPTION_FORMAT_VERSION,
	CAPTION_MIME_TYPE,
	CAPTION_TIMESCALE,
	CaptionCodecError,
	captionContentType,
	decodeCaptionTrack,
	encodeCaptionTrack,
} from '../src/codec'
import type { CaptionSegment } from '../src/types'

const HEADER_BYTES = 40
const RECORD_BYTES = 16
const LITTLE_ENDIAN = true
const BYTE_LENGTH_PATTERN = /byte length/
const DURATION_PATTERN = /durationMs ends before/
const EMPTY_TEXT_PATTERN = /must not be empty/
const EXCEEDS_DURATION_PATTERN = /exceeds track duration/
const INVALID_UTF8_PATTERN = /not valid UTF-8/
const NO_DURATION_PATTERN = /no duration/
const OVERLAP_PATTERN = /overlaps/
const SHORT_HEADER_PATTERN = /shorter than/
const TEXT_RANGE_PATTERN = /non-canonical text range/
const UINT32_PATTERN = /unsigned 32-bit integer/

const sampleSegments = (): CaptionSegment[] => [
	{ endMs: 1250, startMs: 100, text: '“Olá,” she said.' },
	{ endMs: 3200, startMs: 1800, text: 'Καλημέρα 🌅' },
	{ endMs: 5000, startMs: 4000, text: 'Last caption.' },
]

const cloneBytes = (bytes: Uint8Array): Uint8Array => Uint8Array.from(bytes)

const mutate = (
	bytes: Uint8Array,
	change: (view: DataView, copy: Uint8Array) => void
): Uint8Array => {
	const copy = cloneBytes(bytes)
	change(new DataView(copy.buffer), copy)
	return copy
}

describe('TCAP v1 codec', () => {
	test('publishes stable format metadata', () => {
		expect(CAPTION_FORMAT_VERSION).toBe(1)
		expect(CAPTION_TIMESCALE).toBe(1000)
		expect(CAPTION_MIME_TYPE).toBe('application/vnd.tplayer.captions')
		expect(CAPTION_FILE_EXTENSION).toBe('tcap')
		expect(captionContentType()).toBe(
			'application/vnd.tplayer.captions; version=1'
		)
	})

	test('round-trips exact Unicode text and timing through a canonical binary track', () => {
		const segments = sampleSegments()
		const bytes = encodeCaptionTrack({ durationMs: 6500, segments })
		const view = new DataView(bytes.buffer)

		expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe('TCAP')
		expect(view.getUint16(4, LITTLE_ENDIAN)).toBe(1)
		expect(view.getUint16(6, LITTLE_ENDIAN)).toBe(HEADER_BYTES)
		expect(view.getUint32(8, LITTLE_ENDIAN)).toBe(1000)
		expect(view.getUint32(12, LITTLE_ENDIAN)).toBe(0)
		expect(view.getUint32(16, LITTLE_ENDIAN)).toBe(segments.length)
		expect(view.getUint32(20, LITTLE_ENDIAN)).toBe(RECORD_BYTES)
		expect(view.getUint32(24, LITTLE_ENDIAN)).toBe(HEADER_BYTES)
		expect(view.getUint32(28, LITTLE_ENDIAN)).toBe(
			HEADER_BYTES + segments.length * RECORD_BYTES
		)
		expect(view.getUint32(36, LITTLE_ENDIAN)).toBe(6500)

		const track = decodeCaptionTrack(bytes)
		expect(track.byteLength).toBe(bytes.byteLength)
		expect(track.durationMs).toBe(6500)
		expect(track.formatVersion).toBe(1)
		expect(track.segmentCount).toBe(segments.length)
		expect(track.timescale).toBe(1000)
		for (const [index, segment] of segments.entries()) {
			expect(track.startMsAt(index)).toBe(segment.startMs)
			expect(track.endMsAt(index)).toBe(segment.endMs)
			expect(track.textAt(index)).toBe(segment.text)
			expect(track.textAt(index)).toBe(segment.text)
		}
	})

	test('accepts ArrayBuffer and non-zero-offset views without reading adjacent bytes', () => {
		const encoded = encodeCaptionTrack({ segments: sampleSegments() })
		const framed = new Uint8Array(encoded.byteLength + 18)
		framed.fill(0xa5)
		framed.set(encoded, 9)
		const view = framed.subarray(9, 9 + encoded.byteLength)

		const fromView = decodeCaptionTrack(view)
		expect(fromView.textAt(1)).toBe('Καλημέρα 🌅')

		const isolated = encoded.buffer.slice(
			encoded.byteOffset,
			encoded.byteOffset + encoded.byteLength
		)
		const fromBuffer = decodeCaptionTrack(isolated)
		expect(fromBuffer.textAt(2)).toBe('Last caption.')
	})

	test('encodes an empty track as only a header', () => {
		const bytes = encodeCaptionTrack({ segments: [] })
		const track = decodeCaptionTrack(bytes)
		expect(bytes.byteLength).toBe(HEADER_BYTES)
		expect(track.durationMs).toBe(0)
		expect(track.segmentCount).toBe(0)
		expect(() => track.startMsAt(0)).toThrow(RangeError)
		expect(() => track.endMsAt(-1)).toThrow(RangeError)
		expect(() => track.textAt(0.5)).toThrow(RangeError)
	})

	test('rejects invalid source segments before allocating a track', () => {
		expect(() =>
			encodeCaptionTrack({
				segments: [{ endMs: 0, startMs: 0, text: 'zero' }],
			})
		).toThrow(CaptionCodecError)
		expect(() =>
			encodeCaptionTrack({
				segments: [{ endMs: 1.5, startMs: 0, text: 'fractional' }],
			})
		).toThrow(UINT32_PATTERN)
		expect(() =>
			encodeCaptionTrack({
				segments: [{ endMs: 10, startMs: 0, text: '' }],
			})
		).toThrow(EMPTY_TEXT_PATTERN)
		expect(() =>
			encodeCaptionTrack({
				segments: [
					{ endMs: 100, startMs: 0, text: 'first' },
					{ endMs: 150, startMs: 99, text: 'overlap' },
				],
			})
		).toThrow(OVERLAP_PATTERN)
		expect(() =>
			encodeCaptionTrack({
				durationMs: 99,
				segments: [{ endMs: 100, startMs: 0, text: 'too late' }],
			})
		).toThrow(DURATION_PATTERN)
	})

	test('rejects malformed headers, section sizes, and trailing bytes', () => {
		const encoded = encodeCaptionTrack({ segments: sampleSegments() })
		const corruptions: [string, Uint8Array][] = [
			[
				'magic',
				mutate(encoded, (_view, bytes) => {
					bytes[0] = 0
				}),
			],
			['version', mutate(encoded, (view) => view.setUint16(4, 2, true))],
			['header', mutate(encoded, (view) => view.setUint16(6, 36, true))],
			['timescale', mutate(encoded, (view) => view.setUint32(8, 90_000, true))],
			['flags', mutate(encoded, (view) => view.setUint32(12, 1, true))],
			['record size', mutate(encoded, (view) => view.setUint32(20, 12, true))],
			[
				'record offset',
				mutate(encoded, (view) => view.setUint32(24, 44, true)),
			],
			['text offset', mutate(encoded, (view) => view.setUint32(28, 41, true))],
			['text bytes', mutate(encoded, (view) => view.setUint32(32, 0, true))],
		]
		for (const [label, bytes] of corruptions) {
			expect(() => decodeCaptionTrack(bytes), label).toThrow(CaptionCodecError)
		}
		expect(() => decodeCaptionTrack(encoded.subarray(0, 39))).toThrow(
			SHORT_HEADER_PATTERN
		)
		const trailing = new Uint8Array(encoded.byteLength + 1)
		trailing.set(encoded)
		expect(() => decodeCaptionTrack(trailing)).toThrow(BYTE_LENGTH_PATTERN)
	})

	test('rejects invalid record ordering, ranges, duration, and UTF-8', () => {
		const encoded = encodeCaptionTrack({
			durationMs: 6500,
			segments: sampleSegments(),
		})
		const secondRecord = HEADER_BYTES + RECORD_BYTES
		const textOffset = HEADER_BYTES + sampleSegments().length * RECORD_BYTES

		expect(() =>
			decodeCaptionTrack(
				mutate(encoded, (view) => view.setUint32(4 + HEADER_BYTES, 100, true))
			)
		).toThrow(NO_DURATION_PATTERN)
		expect(() =>
			decodeCaptionTrack(
				mutate(encoded, (view) => view.setUint32(secondRecord, 1249, true))
			)
		).toThrow(OVERLAP_PATTERN)
		expect(() =>
			decodeCaptionTrack(
				mutate(encoded, (view) => view.setUint32(36, 4999, true))
			)
		).toThrow(EXCEEDS_DURATION_PATTERN)
		expect(() =>
			decodeCaptionTrack(
				mutate(encoded, (view) => view.setUint32(secondRecord + 8, 1, true))
			)
		).toThrow(TEXT_RANGE_PATTERN)
		expect(() =>
			decodeCaptionTrack(
				mutate(encoded, (view) => view.setUint32(secondRecord + 12, 0, true))
			)
		).toThrow(TEXT_RANGE_PATTERN)
		expect(() =>
			decodeCaptionTrack(
				mutate(encoded, (_view, bytes) => {
					bytes[textOffset] = 0xff
				})
			)
		).toThrow(INVALID_UTF8_PATTERN)
	})

	test('emits byte-for-byte deterministic output', () => {
		const input = { durationMs: 6500, segments: sampleSegments() }
		expect(encodeCaptionTrack(input)).toEqual(encodeCaptionTrack(input))
	})
})

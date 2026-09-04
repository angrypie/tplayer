import type { CaptionTrackInput } from './types'

export const CAPTION_FORMAT_VERSION = 1
export const CAPTION_MIME_TYPE = 'application/vnd.tplayer.captions'
export const CAPTION_FILE_EXTENSION = 'tcap'
export const CAPTION_TIMESCALE = 1000

const HEADER_BYTES = 40
const RECORD_BYTES = 16
const MAGIC_BYTES = Uint8Array.of(0x54, 0x43, 0x41, 0x50)
const MAXIMUM_SEGMENTS = 1_000_000
const MAXIMUM_TRACK_BYTES = 512 * 1024 * 1024
const MAXIMUM_UINT32 = 0xff_ff_ff_ff
const LITTLE_ENDIAN = true

const HEADER_OFFSETS = {
	durationMs: 36,
	flags: 12,
	headerBytes: 6,
	recordBytes: 20,
	recordsOffset: 24,
	segmentCount: 16,
	textBytes: 32,
	textOffset: 28,
	timescale: 8,
	version: 4,
} as const

const RECORD_OFFSETS = {
	endMs: 4,
	startMs: 0,
	textLength: 12,
	textOffset: 8,
} as const

const textEncoder = new TextEncoder()

export type CaptionTrackBytes = ArrayBuffer | ArrayBufferView

export class CaptionCodecError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options)
		this.name = 'CaptionCodecError'
	}
}

export class CaptionTrack {
	readonly byteLength: number
	readonly durationMs: number
	readonly formatVersion = CAPTION_FORMAT_VERSION
	readonly segmentCount: number
	readonly timescale = CAPTION_TIMESCALE

	private readonly dataView: DataView
	private readonly recordsOffset: number
	private readonly textCache: Array<string | undefined>
	private readonly textDecoder = new TextDecoder()
	private readonly textOffset: number
	private readonly bytes: Uint8Array

	constructor(
		bytes: Uint8Array,
		dataView: DataView,
		segmentCount: number,
		durationMs: number,
		recordsOffset: number,
		textOffset: number
	) {
		this.bytes = bytes
		this.dataView = dataView
		this.segmentCount = segmentCount
		this.durationMs = durationMs
		this.recordsOffset = recordsOffset
		this.textOffset = textOffset
		this.byteLength = bytes.byteLength
		this.textCache = Array.from({ length: segmentCount })
	}

	startMsAt(index: number): number {
		return this.readRecordUint32(index, RECORD_OFFSETS.startMs)
	}

	endMsAt(index: number): number {
		return this.readRecordUint32(index, RECORD_OFFSETS.endMs)
	}

	textAt(index: number): string {
		this.assertIndex(index)
		const cached = this.textCache[index]
		if (cached !== undefined) {
			return cached
		}
		const recordOffset = this.recordOffset(index)
		const relativeOffset = this.dataView.getUint32(
			recordOffset + RECORD_OFFSETS.textOffset,
			LITTLE_ENDIAN
		)
		const byteLength = this.dataView.getUint32(
			recordOffset + RECORD_OFFSETS.textLength,
			LITTLE_ENDIAN
		)
		const text = this.textDecoder.decode(
			this.bytes.subarray(
				this.textOffset + relativeOffset,
				this.textOffset + relativeOffset + byteLength
			)
		)
		this.textCache[index] = text
		return text
	}

	private assertIndex(index: number): void {
		if (
			!(Number.isSafeInteger(index) && index >= 0 && index < this.segmentCount)
		) {
			throw new RangeError(`Caption segment index ${index} is out of range`)
		}
	}

	private readRecordUint32(index: number, fieldOffset: number): number {
		this.assertIndex(index)
		return this.dataView.getUint32(
			this.recordOffset(index) + fieldOffset,
			LITTLE_ENDIAN
		)
	}

	private recordOffset(index: number): number {
		return this.recordsOffset + index * RECORD_BYTES
	}
}

export const captionContentType = (): string =>
	`${CAPTION_MIME_TYPE}; version=${CAPTION_FORMAT_VERSION}`

export const encodeCaptionTrack = ({
	durationMs,
	segments,
}: CaptionTrackInput): Uint8Array => {
	assertSegmentCount(segments.length)
	const encodedTexts: Uint8Array[] = []
	let textByteLength = 0
	let previousEndMs = 0
	for (const [index, segment] of segments.entries()) {
		assertTimestamp(segment.startMs, `segments[${index}].startMs`)
		assertTimestamp(segment.endMs, `segments[${index}].endMs`)
		if (segment.endMs <= segment.startMs) {
			throw new CaptionCodecError(`segments[${index}] must end after it starts`)
		}
		if (index > 0 && segment.startMs < previousEndMs) {
			throw new CaptionCodecError(
				`segments[${index}] overlaps the previous segment`
			)
		}
		if (typeof segment.text !== 'string' || segment.text.length === 0) {
			throw new CaptionCodecError(`segments[${index}].text must not be empty`)
		}
		const encodedText = textEncoder.encode(segment.text)
		if (encodedText.byteLength === 0) {
			throw new CaptionCodecError(`segments[${index}].text must not be empty`)
		}
		textByteLength = checkedSum(
			textByteLength,
			encodedText.byteLength,
			'Caption text is too large'
		)
		encodedTexts.push(encodedText)
		previousEndMs = segment.endMs
	}

	const resolvedDurationMs = durationMs ?? previousEndMs
	assertTimestamp(resolvedDurationMs, 'durationMs')
	if (resolvedDurationMs < previousEndMs) {
		throw new CaptionCodecError(
			'durationMs ends before the final caption segment'
		)
	}

	const recordsByteLength = checkedProduct(
		segments.length,
		RECORD_BYTES,
		'Caption record table is too large'
	)
	const textOffset = checkedSum(
		HEADER_BYTES,
		recordsByteLength,
		'Caption record table is too large'
	)
	const totalByteLength = checkedSum(
		textOffset,
		textByteLength,
		'Caption track is too large'
	)
	if (totalByteLength > MAXIMUM_TRACK_BYTES) {
		throw new CaptionCodecError(
			`Caption track exceeds ${MAXIMUM_TRACK_BYTES} bytes`
		)
	}

	const bytes = new Uint8Array(totalByteLength)
	bytes.set(MAGIC_BYTES)
	const view = new DataView(bytes.buffer)
	view.setUint16(HEADER_OFFSETS.version, CAPTION_FORMAT_VERSION, LITTLE_ENDIAN)
	view.setUint16(HEADER_OFFSETS.headerBytes, HEADER_BYTES, LITTLE_ENDIAN)
	view.setUint32(HEADER_OFFSETS.timescale, CAPTION_TIMESCALE, LITTLE_ENDIAN)
	view.setUint32(HEADER_OFFSETS.flags, 0, LITTLE_ENDIAN)
	view.setUint32(HEADER_OFFSETS.segmentCount, segments.length, LITTLE_ENDIAN)
	view.setUint32(HEADER_OFFSETS.recordBytes, RECORD_BYTES, LITTLE_ENDIAN)
	view.setUint32(HEADER_OFFSETS.recordsOffset, HEADER_BYTES, LITTLE_ENDIAN)
	view.setUint32(HEADER_OFFSETS.textOffset, textOffset, LITTLE_ENDIAN)
	view.setUint32(HEADER_OFFSETS.textBytes, textByteLength, LITTLE_ENDIAN)
	view.setUint32(HEADER_OFFSETS.durationMs, resolvedDurationMs, LITTLE_ENDIAN)

	let relativeTextOffset = 0
	for (const [index, segment] of segments.entries()) {
		const recordOffset = HEADER_BYTES + index * RECORD_BYTES
		const encodedText = encodedTexts[index]
		if (!encodedText) {
			throw new CaptionCodecError('Caption text encoding is incomplete')
		}
		view.setUint32(
			recordOffset + RECORD_OFFSETS.startMs,
			segment.startMs,
			LITTLE_ENDIAN
		)
		view.setUint32(
			recordOffset + RECORD_OFFSETS.endMs,
			segment.endMs,
			LITTLE_ENDIAN
		)
		view.setUint32(
			recordOffset + RECORD_OFFSETS.textOffset,
			relativeTextOffset,
			LITTLE_ENDIAN
		)
		view.setUint32(
			recordOffset + RECORD_OFFSETS.textLength,
			encodedText.byteLength,
			LITTLE_ENDIAN
		)
		bytes.set(encodedText, textOffset + relativeTextOffset)
		relativeTextOffset += encodedText.byteLength
	}
	return bytes
}

export const decodeCaptionTrack = (input: CaptionTrackBytes): CaptionTrack => {
	const bytes = toByteView(input)
	if (bytes.byteLength < HEADER_BYTES) {
		throw new CaptionCodecError('Caption track is shorter than the TCAP header')
	}
	if (bytes.byteLength > MAXIMUM_TRACK_BYTES) {
		throw new CaptionCodecError(
			`Caption track exceeds ${MAXIMUM_TRACK_BYTES} bytes`
		)
	}
	assertMagic(bytes)
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
	const version = view.getUint16(HEADER_OFFSETS.version, LITTLE_ENDIAN)
	if (version !== CAPTION_FORMAT_VERSION) {
		throw new CaptionCodecError(`Unsupported TCAP version ${version}`)
	}
	const headerBytes = view.getUint16(HEADER_OFFSETS.headerBytes, LITTLE_ENDIAN)
	const timescale = view.getUint32(HEADER_OFFSETS.timescale, LITTLE_ENDIAN)
	const flags = view.getUint32(HEADER_OFFSETS.flags, LITTLE_ENDIAN)
	const segmentCount = view.getUint32(
		HEADER_OFFSETS.segmentCount,
		LITTLE_ENDIAN
	)
	const recordBytes = view.getUint32(HEADER_OFFSETS.recordBytes, LITTLE_ENDIAN)
	const recordsOffset = view.getUint32(
		HEADER_OFFSETS.recordsOffset,
		LITTLE_ENDIAN
	)
	const textOffset = view.getUint32(HEADER_OFFSETS.textOffset, LITTLE_ENDIAN)
	const textBytes = view.getUint32(HEADER_OFFSETS.textBytes, LITTLE_ENDIAN)
	const durationMs = view.getUint32(HEADER_OFFSETS.durationMs, LITTLE_ENDIAN)

	if (headerBytes !== HEADER_BYTES) {
		throw new CaptionCodecError(`TCAP v1 header must be ${HEADER_BYTES} bytes`)
	}
	if (timescale !== CAPTION_TIMESCALE) {
		throw new CaptionCodecError(`Unsupported TCAP timescale ${timescale}`)
	}
	if (flags !== 0) {
		throw new CaptionCodecError('TCAP v1 flags must be zero')
	}
	if (recordBytes !== RECORD_BYTES) {
		throw new CaptionCodecError(`TCAP v1 records must be ${RECORD_BYTES} bytes`)
	}
	assertSegmentCount(segmentCount)
	const expectedTextOffset = checkedSum(
		recordsOffset,
		checkedProduct(segmentCount, recordBytes, 'TCAP record table is too large'),
		'TCAP record table is too large'
	)
	const expectedByteLength = checkedSum(
		textOffset,
		textBytes,
		'TCAP text pool is too large'
	)
	if (recordsOffset !== headerBytes || textOffset !== expectedTextOffset) {
		throw new CaptionCodecError('TCAP sections are not in canonical order')
	}
	if (expectedByteLength !== bytes.byteLength) {
		throw new CaptionCodecError('TCAP byte length does not match its header')
	}

	validateTextPool(bytes.subarray(textOffset), textBytes)
	validateRecords(
		view,
		segmentCount,
		recordsOffset,
		textBytes,
		durationMs,
		bytes
	)
	return new CaptionTrack(
		bytes,
		view,
		segmentCount,
		durationMs,
		recordsOffset,
		textOffset
	)
}

const assertTimestamp = (value: number, name: string): void => {
	if (!Number.isSafeInteger(value) || value < 0 || value > MAXIMUM_UINT32) {
		throw new CaptionCodecError(`${name} must be an unsigned 32-bit integer`)
	}
}

const assertSegmentCount = (value: number): void => {
	if (!Number.isSafeInteger(value) || value < 0 || value > MAXIMUM_SEGMENTS) {
		throw new CaptionCodecError(
			`Caption segment count must be between 0 and ${MAXIMUM_SEGMENTS}`
		)
	}
}

const assertMagic = (bytes: Uint8Array): void => {
	for (const [index, expected] of MAGIC_BYTES.entries()) {
		if (bytes[index] !== expected) {
			throw new CaptionCodecError('Caption track does not use the TCAP format')
		}
	}
}

const checkedProduct = (
	left: number,
	right: number,
	message: string
): number => {
	const value = left * right
	if (!Number.isSafeInteger(value) || value > MAXIMUM_UINT32) {
		throw new CaptionCodecError(message)
	}
	return value
}

const checkedSum = (left: number, right: number, message: string): number => {
	const value = left + right
	if (!Number.isSafeInteger(value) || value > MAXIMUM_UINT32) {
		throw new CaptionCodecError(message)
	}
	return value
}

const isUtf8ContinuationByte = (value: number | undefined): boolean =>
	value !== undefined && value >= 0x80 && value <= 0xbf

const toByteView = (input: CaptionTrackBytes): Uint8Array => {
	if (input instanceof ArrayBuffer) {
		return new Uint8Array(input)
	}
	return new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
}

const validateRecords = (
	view: DataView,
	segmentCount: number,
	recordsOffset: number,
	textBytes: number,
	durationMs: number,
	bytes: Uint8Array
): void => {
	let expectedRelativeTextOffset = 0
	let previousEndMs = 0
	const textPoolOffset = recordsOffset + segmentCount * RECORD_BYTES
	for (let index = 0; index < segmentCount; index += 1) {
		const recordOffset = recordsOffset + index * RECORD_BYTES
		const startMs = view.getUint32(
			recordOffset + RECORD_OFFSETS.startMs,
			LITTLE_ENDIAN
		)
		const endMs = view.getUint32(
			recordOffset + RECORD_OFFSETS.endMs,
			LITTLE_ENDIAN
		)
		const relativeTextOffset = view.getUint32(
			recordOffset + RECORD_OFFSETS.textOffset,
			LITTLE_ENDIAN
		)
		const textLength = view.getUint32(
			recordOffset + RECORD_OFFSETS.textLength,
			LITTLE_ENDIAN
		)
		if (endMs <= startMs) {
			throw new CaptionCodecError(`TCAP segment ${index} has no duration`)
		}
		if (index > 0 && startMs < previousEndMs) {
			throw new CaptionCodecError(
				`TCAP segment ${index} overlaps its predecessor`
			)
		}
		if (endMs > durationMs) {
			throw new CaptionCodecError(
				`TCAP segment ${index} exceeds track duration`
			)
		}
		if (relativeTextOffset !== expectedRelativeTextOffset || textLength === 0) {
			throw new CaptionCodecError(
				`TCAP segment ${index} has a non-canonical text range`
			)
		}
		expectedRelativeTextOffset = checkedSum(
			expectedRelativeTextOffset,
			textLength,
			'TCAP text ranges overflow'
		)
		if (expectedRelativeTextOffset > textBytes) {
			throw new CaptionCodecError(`TCAP segment ${index} text is out of bounds`)
		}
		const absoluteTextStart = textPoolOffset + relativeTextOffset
		const absoluteTextEnd = textPoolOffset + expectedRelativeTextOffset
		if (
			isUtf8ContinuationByte(bytes[absoluteTextStart]) ||
			isUtf8ContinuationByte(bytes[absoluteTextEnd])
		) {
			throw new CaptionCodecError(
				`TCAP segment ${index} text splits a UTF-8 code point`
			)
		}
		previousEndMs = endMs
	}
	if (expectedRelativeTextOffset !== textBytes) {
		throw new CaptionCodecError('TCAP text pool contains unreferenced bytes')
	}
}

const validateTextPool = (
	textPool: Uint8Array,
	expectedBytes: number
): void => {
	if (textPool.byteLength !== expectedBytes) {
		throw new CaptionCodecError('TCAP text pool has an invalid byte length')
	}
	try {
		new TextDecoder('utf-8', { fatal: true }).decode(textPool)
	} catch (cause) {
		throw new CaptionCodecError('TCAP text pool is not valid UTF-8', { cause })
	}
}

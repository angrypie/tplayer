import { HttpError } from '../errors'

const BYTE_RANGE_PATTERN = /^bytes=(\d*)-(\d*)$/i

export interface ByteRange {
	end: number
	length: number
	start: number
}

export const parseByteRange = (
	header: string | undefined,
	size: number
): ByteRange | null => {
	const rangeError = (message: string): HttpError =>
		new HttpError(416, 'invalid_range', message, {
			'Content-Range': `bytes */${size}`,
		})
	if (header === undefined) {
		return null
	}
	if (!(Number.isSafeInteger(size) && size >= 0)) {
		throw new Error('File size must be a non-negative safe integer')
	}
	if (header.includes(',')) {
		throw rangeError('Multiple byte ranges are unsupported')
	}
	const match = BYTE_RANGE_PATTERN.exec(header.trim())
	if (!(match?.[1] || match?.[2])) {
		throw rangeError('Invalid byte range')
	}
	if (size === 0) {
		throw rangeError('Empty files have no byte ranges')
	}

	const startText = match[1] ?? ''
	const endText = match[2] ?? ''
	let start: number
	let end: number
	if (startText === '') {
		const suffixLength = Number(endText)
		if (!(Number.isSafeInteger(suffixLength) && suffixLength > 0)) {
			throw rangeError('Invalid suffix byte range')
		}
		start = Math.max(size - suffixLength, 0)
		end = size - 1
	} else {
		start = Number(startText)
		end = endText === '' ? size - 1 : Number(endText)
		if (
			!(Number.isSafeInteger(start) && Number.isSafeInteger(end)) ||
			start < 0 ||
			start >= size ||
			end < start
		) {
			throw rangeError('Unsatisfiable byte range')
		}
		end = Math.min(end, size - 1)
	}
	return { end, length: end - start + 1, start }
}

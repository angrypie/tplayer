import { describe, expect, test } from 'bun:test'
import { torrentFileMediaType } from './mediaType'

describe('torrent file media types', () => {
	test('serves M4B containers as browser-compatible MP4 audio', () => {
		expect(
			torrentFileMediaType('Matthew McConaughey - Greenlights (2020).m4b', '')
		).toBe('audio/mp4')
		expect(
			torrentFileMediaType('Disc 2/CHAPTER 12.M4B', 'application/octet-stream')
		).toBe('audio/mp4')
		expect(torrentFileMediaType('book.m4b', 'audio/x-m4b')).toBe('audio/mp4')
	})

	test('preserves detected media types for other files and rejects malformed values', () => {
		expect(torrentFileMediaType('chapter.mp3', 'audio/mpeg')).toBe('audio/mpeg')
		expect(
			torrentFileMediaType('cover.jpg', ' IMAGE/JPEG ; charset=binary')
		).toBe('image/jpeg')
		expect(torrentFileMediaType('unknown.bin', 'not-a-media-type')).toBe(
			'application/octet-stream'
		)
	})
})

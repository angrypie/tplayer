import { describe, expect, test } from 'bun:test'
import { getAudioFormat } from './index.js'

describe('browser audio format selection', () => {
	test('uses the MP4 demuxer for M4B files regardless of server MIME fallback', () => {
		expect(
			getAudioFormat({
				mimeType: 'application/octet-stream',
				name: 'Greenlights.m4b',
				path: ['Greenlights.m4b'],
			})
		).toBe('mp4')
		expect(
			getAudioFormat({
				mimeType: 'audio/mp4',
				name: 'GREENLIGHTS.M4B',
				path: ['GREENLIGHTS.M4B'],
			})
		).toBe('mp4')
	})

	test('continues to resolve extensionless audio from its detected MIME type', () => {
		expect(
			getAudioFormat({
				mimeType: 'audio/mpeg; charset=binary',
				name: 'chapter-without-extension',
				path: ['chapter-without-extension'],
			})
		).toBe('mp3')
	})
})

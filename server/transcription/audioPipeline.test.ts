import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'bun'
import {
	AudioPipelineError,
	type AudioWindow,
	encodePcm16Wav,
	FfmpegAudioTranscoder,
	transcodePcmWindows,
} from './audioPipeline'

const BITS_PER_SAMPLE = 16
const BYTES_PER_MILLISECOND = 32
const CHANNELS = 1
const SAMPLE_RATE = 16_000
const WAV_HEADER_BYTES = 44
const FFMPEG_EXECUTABLE = process.env.TPLAYER_FFMPEG_PATH ?? 'ffmpeg'

const pcmForDuration = (durationMs: number): Uint8Array =>
	new Uint8Array(durationMs * BYTES_PER_MILLISECOND)

const streamFrom = (
	chunks: readonly Uint8Array[],
	strategy?: QueuingStrategy<Uint8Array>
): ReadableStream<Uint8Array> => {
	let index = 0
	return new ReadableStream<Uint8Array>(
		{
			pull(controller) {
				const chunk = chunks[index]
				if (!chunk) {
					controller.close()
					return
				}
				index += 1
				controller.enqueue(chunk)
			},
		},
		strategy
	)
}

const ascii = (bytes: Uint8Array, start: number, length: number): string =>
	new TextDecoder().decode(bytes.subarray(start, start + length))

const expectPcmWav = (wav: Uint8Array, pcmByteLength: number): void => {
	const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength)
	expect(ascii(wav, 0, 4)).toBe('RIFF')
	expect(view.getUint32(4, true)).toBe(WAV_HEADER_BYTES + pcmByteLength - 8)
	expect(ascii(wav, 8, 4)).toBe('WAVE')
	expect(ascii(wav, 12, 4)).toBe('fmt ')
	expect(view.getUint32(16, true)).toBe(16)
	expect(view.getUint16(20, true)).toBe(1)
	expect(view.getUint16(22, true)).toBe(CHANNELS)
	expect(view.getUint32(24, true)).toBe(SAMPLE_RATE)
	expect(view.getUint32(28, true)).toBe(
		SAMPLE_RATE * CHANNELS * (BITS_PER_SAMPLE / 8)
	)
	expect(view.getUint16(32, true)).toBe(CHANNELS * (BITS_PER_SAMPLE / 8))
	expect(view.getUint16(34, true)).toBe(BITS_PER_SAMPLE)
	expect(ascii(wav, 36, 4)).toBe('data')
	expect(view.getUint32(40, true)).toBe(pcmByteLength)
	expect(wav.byteLength).toBe(WAV_HEADER_BYTES + pcmByteLength)
}

const ffmpegAvailable = async (): Promise<boolean> => {
	try {
		const probe = spawn({
			cmd: [FFMPEG_EXECUTABLE, '-version'],
			stderr: 'ignore',
			stdout: 'ignore',
		})
		return (await probe.exited) === 0
	} catch {
		return false
	}
}

const ffmpegTest = (await ffmpegAvailable()) ? test : test.skip

describe('PCM WAV encoding', () => {
	test('writes a valid 16 kHz mono PCM16 WAV header and preserves samples', () => {
		const pcm = Uint8Array.of(0x12, 0x34, 0xab, 0xcd)
		const wav = encodePcm16Wav(pcm)

		expectPcmWav(wav, pcm.byteLength)
		expect(wav.subarray(WAV_HEADER_BYTES)).toEqual(pcm)
	})

	test('rejects incomplete PCM16 samples from direct and streamed input', async () => {
		expect(() => encodePcm16Wav(Uint8Array.of(1))).toThrow(AudioPipelineError)
		expect(() => encodePcm16Wav(Uint8Array.of(1))).toThrow(
			'incomplete PCM sample'
		)

		const transcode = transcodePcmWindows(
			streamFrom([Uint8Array.of(1)]),
			new AbortController().signal,
			() => Promise.resolve()
		)
		await expect(transcode).rejects.toMatchObject({ code: 'invalid_pcm' })
	})
})

describe('PCM caption windows', () => {
	test('emits 90-second logical windows with two seconds of context on each boundary', async () => {
		const windows: AudioWindow[] = []
		const result = await transcodePcmWindows(
			streamFrom([
				pcmForDuration(91_000),
				pcmForDuration(1000),
				pcmForDuration(89_000),
				pcmForDuration(1000),
				pcmForDuration(3000),
			]),
			new AbortController().signal,
			(window) => {
				windows.push(window)
				return Promise.resolve()
			}
		)

		expect(result).toEqual({ durationMs: 185_000 })
		expect(
			windows.map(({ inputStartMs, logicalEndMs, logicalStartMs }) => ({
				inputStartMs,
				logicalEndMs,
				logicalStartMs,
			}))
		).toEqual([
			{ inputStartMs: 0, logicalEndMs: 90_000, logicalStartMs: 0 },
			{
				inputStartMs: 88_000,
				logicalEndMs: 180_000,
				logicalStartMs: 90_000,
			},
			{
				inputStartMs: 178_000,
				logicalEndMs: 185_000,
				logicalStartMs: 180_000,
			},
		])
		expectPcmWav(windows[0]?.wav ?? new Uint8Array(), 92_000 * 32)
		expectPcmWav(windows[1]?.wav ?? new Uint8Array(), 94_000 * 32)
		expectPcmWav(windows[2]?.wav ?? new Uint8Array(), 7000 * 32)
	})

	test('backpressures input while a window callback is pending', async () => {
		const callbackEntered = Promise.withResolvers<void>()
		const releaseCallback = Promise.withResolvers<void>()
		let pullCount = 0
		const chunks = [pcmForDuration(92_000), pcmForDuration(1000)]
		let index = 0
		const stream = new ReadableStream<Uint8Array>(
			{
				pull(controller) {
					pullCount += 1
					const chunk = chunks[index]
					if (!chunk) {
						controller.close()
						return
					}
					index += 1
					controller.enqueue(chunk)
				},
			},
			{ highWaterMark: 0 }
		)
		let callbackCount = 0
		const transcode = transcodePcmWindows(
			stream,
			new AbortController().signal,
			async () => {
				callbackCount += 1
				callbackEntered.resolve()
				await releaseCallback.promise
			}
		)

		await callbackEntered.promise
		expect(pullCount).toBe(1)
		releaseCallback.resolve()
		await expect(transcode).resolves.toEqual({ durationMs: 93_000 })
		expect(pullCount).toBe(3)
		expect(callbackCount).toBe(2)
	})

	test('stops before reading more PCM after cancellation', async () => {
		const abortController = new AbortController()
		let pullCount = 0
		const stream = new ReadableStream<Uint8Array>(
			{
				pull(controller) {
					pullCount += 1
					controller.enqueue(pcmForDuration(92_000))
				},
			},
			{ highWaterMark: 0 }
		)
		const transcode = transcodePcmWindows(
			stream,
			abortController.signal,
			() => {
				abortController.abort()
				return Promise.resolve()
			}
		)

		await expect(transcode).rejects.toMatchObject({ name: 'AbortError' })
		expect(pullCount).toBe(1)
	})
})

describe('FFmpeg audiobook decoding', () => {
	ffmpegTest(
		'kills a backpressured decoder and cancels its cache source before settling',
		async () => {
			const durationMs = 10 * 60 * 1000
			const declaredPcmBytes = durationMs * BYTES_PER_MILLISECOND
			const header = encodePcm16Wav(new Uint8Array())
			const headerView = new DataView(header.buffer)
			headerView.setUint32(4, WAV_HEADER_BYTES + declaredPcmBytes - 8, true)
			headerView.setUint32(40, declaredPcmBytes, true)
			const callbackEntered = Promise.withResolvers<void>()
			const sourceCancelled = Promise.withResolvers<void>()
			const abortController = new AbortController()
			let headerSent = false
			let remaining = declaredPcmBytes
			const source = new ReadableStream<Uint8Array>(
				{
					cancel() {
						sourceCancelled.resolve()
					},
					pull(controller) {
						if (!headerSent) {
							headerSent = true
							controller.enqueue(header)
							return
						}
						if (remaining === 0) {
							controller.close()
							return
						}
						const length = Math.min(64 * 1024, remaining)
						remaining -= length
						controller.enqueue(new Uint8Array(length))
					},
				},
				{ highWaterMark: 0 }
			)
			const transcode = new FfmpegAudioTranscoder(FFMPEG_EXECUTABLE).transcode(
				source,
				abortController.signal,
				async () => {
					callbackEntered.resolve()
					if (!abortController.signal.aborted) {
						await new Promise<void>((resolve) => {
							abortController.signal.addEventListener(
								'abort',
								() => resolve(),
								{
									once: true,
								}
							)
						})
					}
					const error = new Error('cancelled callback')
					error.name = 'AbortError'
					throw error
				}
			)

			await callbackEntered.promise
			abortController.abort()

			await expect(transcode).rejects.toMatchObject({ name: 'AbortError' })
			await sourceCancelled.promise
			expect(remaining).toBeGreaterThan(0)
		},
		10_000
	)

	ffmpegTest(
		'decodes a seek-dependent tail-moov M4B from its validated local path',
		async () => {
			const root = await mkdtemp(join(tmpdir(), 'tplayer-tail-moov-'))
			try {
				const path = join(root, 'tail-moov.m4b')
				const encoder = spawn({
					cmd: [
						FFMPEG_EXECUTABLE,
						'-hide_banner',
						'-loglevel',
						'error',
						'-f',
						'lavfi',
						'-i',
						'sine=frequency=440:sample_rate=16000:duration=60',
						'-c:a',
						'aac',
						'-b:a',
						'64k',
						path,
					],
					stderr: 'pipe',
					stdout: 'ignore',
				})
				const [exitCode, diagnostic] = await Promise.all([
					encoder.exited,
					new Response(encoder.stderr).text(),
				])
				if (exitCode !== 0) {
					throw new Error(`FFmpeg fixture generation failed: ${diagnostic}`)
				}
				const bytes = new Uint8Array(await readFile(path))
				const text = new TextDecoder('latin1').decode(bytes)
				expect(text.indexOf('moov')).toBeGreaterThan(text.indexOf('mdat'))

				let streamRead = false
				const windows: AudioWindow[] = []
				const result = await new FfmpegAudioTranscoder(
					FFMPEG_EXECUTABLE
				).transcode(
					new ReadableStream<Uint8Array>(
						{
							pull() {
								streamRead = true
								throw new Error('The leased fallback stream must remain unread')
							},
						},
						{ highWaterMark: 0 }
					),
					new AbortController().signal,
					(window) => {
						windows.push(window)
						return Promise.resolve()
					},
					{ localPath: path }
				)
				expect(result.durationMs).toBeGreaterThanOrEqual(59_900)
				expect(windows).toHaveLength(1)
				expect(windows[0]?.wav.byteLength).toBeGreaterThan(1_900_000)
				expect(streamRead).toBe(false)
			} finally {
				await rm(root, { force: true, recursive: true })
			}
		},
		15_000
	)

	ffmpegTest(
		'blocks nested network protocols from a direct local input',
		async () => {
			const root = await mkdtemp(join(tmpdir(), 'tplayer-local-protocol-'))
			try {
				const path = join(root, 'remote-segment.m3u8')
				await writeFile(
					path,
					[
						'#EXTM3U',
						'#EXT-X-VERSION:3',
						'#EXT-X-TARGETDURATION:1',
						'#EXT-X-MEDIA-SEQUENCE:0',
						'#EXTINF:1.0,',
						'http://127.0.0.1:9/segment.ts',
						'#EXT-X-ENDLIST',
						'',
					].join('\n')
				)

				let rejection: unknown
				try {
					await new FfmpegAudioTranscoder(FFMPEG_EXECUTABLE).transcode(
						streamFrom([]),
						new AbortController().signal,
						() => Promise.resolve(),
						{ localPath: path }
					)
				} catch (error) {
					rejection = error
				}

				expect(rejection).toBeInstanceOf(AudioPipelineError)
				if (!(rejection instanceof AudioPipelineError)) {
					throw new Error('Expected FFmpeg to reject the nested network URL')
				}
				expect(rejection.code).toBe('audio_decode_failed')
				expect(String(rejection.cause)).toContain(
					"Protocol 'http' not on whitelist 'file'"
				)
			} finally {
				await rm(root, { force: true, recursive: true })
			}
		},
		10_000
	)

	ffmpegTest(
		'reports the FFmpeg decode failure when the input pipe closes first',
		async () => {
			const transcode = new FfmpegAudioTranscoder(FFMPEG_EXECUTABLE).transcode(
				streamFrom([Uint8Array.from([1, 2, 3, 4])]),
				new AbortController().signal,
				() => Promise.resolve()
			)
			await expect(transcode).rejects.toMatchObject({
				code: 'audio_decode_failed',
			})
		},
		10_000
	)

	ffmpegTest(
		'rejects a nonempty audio container that decodes to zero PCM',
		async () => {
			const transcode = new FfmpegAudioTranscoder(FFMPEG_EXECUTABLE).transcode(
				streamFrom([encodePcm16Wav(new Uint8Array())]),
				new AbortController().signal,
				() => Promise.resolve()
			)
			await expect(transcode).rejects.toMatchObject({
				code: 'audio_decode_empty',
			})
		}
	)
})

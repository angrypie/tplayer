import { type FileSink, spawn } from 'bun'
import { asError } from '../errors'

const BITS_PER_SAMPLE = 16
const BYTES_PER_SAMPLE = BITS_PER_SAMPLE / 8
const CHANNELS = 1
const CONTEXT_MILLISECONDS = 2000
const MAXIMUM_DIAGNOSTIC_BYTES = 64 * 1024
const PROCESS_TERMINATION_GRACE_MS = 250
const SAMPLE_RATE = 16_000
const WAV_HEADER_BYTES = 44
const WINDOW_MILLISECONDS = 90_000
const BYTES_PER_MILLISECOND = (SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE) / 1000

export interface AudioWindow {
	inputStartMs: number
	logicalEndMs: number
	logicalStartMs: number
	wav: Uint8Array
}

export interface AudioTranscodeResult {
	durationMs: number
}

export interface AudioTranscodeOptions {
	localPath?: string
}

export interface AudioTranscoder {
	transcode: (
		source: ReadableStream<Uint8Array>,
		signal: AbortSignal,
		onWindow: (window: AudioWindow) => Promise<void>,
		options?: AudioTranscodeOptions
	) => Promise<AudioTranscodeResult>
}

export class AudioPipelineError extends Error {
	readonly code: string

	constructor(code: string, message: string, options?: ErrorOptions) {
		super(message, options)
		this.name = 'AudioPipelineError'
		this.code = code
	}
}

class ChunkQueue {
	private readonly chunks: Uint8Array[] = []
	private firstOffset = 0
	byteLength = 0

	discard(length: number): void {
		let remaining = length
		while (remaining > 0) {
			const [first] = this.chunks
			if (!first) {
				throw new Error('PCM queue underflow')
			}
			const available = first.byteLength - this.firstOffset
			if (remaining < available) {
				this.firstOffset += remaining
				this.byteLength -= remaining
				return
			}
			remaining -= available
			this.byteLength -= available
			this.chunks.shift()
			this.firstOffset = 0
		}
	}

	push(chunk: Uint8Array): void {
		if (chunk.byteLength === 0) {
			return
		}
		this.chunks.push(chunk)
		this.byteLength += chunk.byteLength
	}

	prefix(length: number): Uint8Array {
		if (length > this.byteLength) {
			throw new Error('PCM queue underflow')
		}
		const result = new Uint8Array(length)
		let outputOffset = 0
		let chunkIndex = 0
		let chunkOffset = this.firstOffset
		while (outputOffset < length) {
			const chunk = this.chunks[chunkIndex]
			if (!chunk) {
				throw new Error('PCM queue underflow')
			}
			const copied = Math.min(
				chunk.byteLength - chunkOffset,
				length - outputOffset
			)
			result.set(
				chunk.subarray(chunkOffset, chunkOffset + copied),
				outputOffset
			)
			outputOffset += copied
			chunkIndex += 1
			chunkOffset = 0
		}
		return result
	}
}

const abortError = (): Error => {
	const error = new Error('Audio transcription was cancelled')
	error.name = 'AbortError'
	return error
}

const throwIfAborted = (signal: AbortSignal): void => {
	if (signal.aborted) {
		throw abortError()
	}
}

const writeAscii = (bytes: Uint8Array, offset: number, value: string): void => {
	bytes.set(new TextEncoder().encode(value), offset)
}

export const encodePcm16Wav = (pcm: Uint8Array): Uint8Array => {
	if (pcm.byteLength % BYTES_PER_SAMPLE !== 0) {
		throw new AudioPipelineError(
			'invalid_pcm',
			'FFmpeg produced an incomplete PCM sample.'
		)
	}
	const bytes = new Uint8Array(WAV_HEADER_BYTES + pcm.byteLength)
	const view = new DataView(bytes.buffer)
	writeAscii(bytes, 0, 'RIFF')
	view.setUint32(4, bytes.byteLength - 8, true)
	writeAscii(bytes, 8, 'WAVE')
	writeAscii(bytes, 12, 'fmt ')
	view.setUint32(16, 16, true)
	view.setUint16(20, 1, true)
	view.setUint16(22, CHANNELS, true)
	view.setUint32(24, SAMPLE_RATE, true)
	view.setUint32(28, SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE, true)
	view.setUint16(32, CHANNELS * BYTES_PER_SAMPLE, true)
	view.setUint16(34, BITS_PER_SAMPLE, true)
	writeAscii(bytes, 36, 'data')
	view.setUint32(40, pcm.byteLength, true)
	bytes.set(pcm, WAV_HEADER_BYTES)
	return bytes
}

const windowByteLength = (milliseconds: number): number =>
	Math.round(milliseconds * BYTES_PER_MILLISECOND)

const emitFullWindows = async (
	queue: ChunkQueue,
	signal: AbortSignal,
	onWindow: (window: AudioWindow) => Promise<void>,
	state: { bufferStartMs: number; logicalStartMs: number }
): Promise<void> => {
	let logicalEndMs = state.logicalStartMs + WINDOW_MILLISECONDS
	let inputEndMs = logicalEndMs + CONTEXT_MILLISECONDS
	let requiredBytes = windowByteLength(inputEndMs - state.bufferStartMs)
	while (queue.byteLength >= requiredBytes) {
		throwIfAborted(signal)
		// biome-ignore lint/performance/noAwaitInLoops: Speech inference is intentionally sequential to bound memory.
		await onWindow({
			inputStartMs: state.bufferStartMs,
			logicalEndMs,
			logicalStartMs: state.logicalStartMs,
			wav: encodePcm16Wav(queue.prefix(requiredBytes)),
		})
		const nextBufferStartMs = logicalEndMs - CONTEXT_MILLISECONDS
		queue.discard(windowByteLength(nextBufferStartMs - state.bufferStartMs))
		state.bufferStartMs = nextBufferStartMs
		state.logicalStartMs = logicalEndMs
		logicalEndMs = state.logicalStartMs + WINDOW_MILLISECONDS
		inputEndMs = logicalEndMs + CONTEXT_MILLISECONDS
		requiredBytes = windowByteLength(inputEndMs - state.bufferStartMs)
	}
}

export const transcodePcmWindows = async (
	stream: ReadableStream<Uint8Array>,
	signal: AbortSignal,
	onWindow: (window: AudioWindow) => Promise<void>
): Promise<AudioTranscodeResult> => {
	const queue = new ChunkQueue()
	const state = { bufferStartMs: 0, logicalStartMs: 0 }
	let totalBytes = 0
	const reader = stream.getReader()
	try {
		let complete = false
		while (!complete) {
			throwIfAborted(signal)
			// biome-ignore lint/performance/noAwaitInLoops: PCM decoding is intentionally sequential and backpressured.
			const { done, value } = await reader.read()
			if (done) {
				complete = true
				continue
			}
			totalBytes += value.byteLength
			queue.push(value)
			await emitFullWindows(queue, signal, onWindow, state)
		}
	} finally {
		reader.releaseLock()
	}
	if (totalBytes % BYTES_PER_SAMPLE !== 0) {
		throw new AudioPipelineError(
			'invalid_pcm',
			'FFmpeg produced an incomplete PCM sample.'
		)
	}
	const durationMs = Math.floor(totalBytes / BYTES_PER_MILLISECOND)
	if (state.logicalStartMs < durationMs && queue.byteLength > 0) {
		throwIfAborted(signal)
		await onWindow({
			inputStartMs: state.bufferStartMs,
			logicalEndMs: durationMs,
			logicalStartMs: state.logicalStartMs,
			wav: encodePcm16Wav(queue.prefix(queue.byteLength)),
		})
	}
	return { durationMs }
}

const pumpInput = async (
	source: ReadableStream<Uint8Array>,
	sink: FileSink,
	signal: AbortSignal
): Promise<number> => {
	const reader = source.getReader()
	let byteLength = 0
	let cancellation: Promise<void> | null = null
	const cancel = (reason: unknown): Promise<void> => {
		if (cancellation) {
			return cancellation
		}
		cancellation = (async () => {
			try {
				await reader.cancel(reason)
			} catch {
				// A failed source cancel is surfaced by its read or release owner.
			}
			try {
				await Promise.resolve(sink.end(asError(reason)))
			} catch {
				// FFmpeg may already have closed stdin during process cleanup.
			}
		})()
		return cancellation
	}
	const onAbort = (): void => {
		cancel(signal.reason ?? abortError()).catch(() => undefined)
	}
	if (signal.aborted) {
		onAbort()
	} else {
		signal.addEventListener('abort', onAbort, { once: true })
	}
	try {
		let complete = false
		while (!complete) {
			throwIfAborted(signal)
			// biome-ignore lint/performance/noAwaitInLoops: The pipe must honor FFmpeg backpressure.
			const { done, value } = await reader.read()
			if (done) {
				complete = true
				continue
			}
			byteLength += value.byteLength
			await sink.write(value)
		}
		await sink.end()
		return byteLength
	} catch (value) {
		await cancel(value)
		throw value
	} finally {
		signal.removeEventListener('abort', onAbort)
		if (cancellation) {
			await cancellation
		}
		reader.releaseLock()
	}
}

const settlesWithin = async (
	operation: Promise<unknown>,
	timeoutMs: number
): Promise<boolean> => {
	let timeout: ReturnType<typeof setTimeout> | null = null
	const settled = await Promise.race([
		operation.then(
			() => true,
			() => true
		),
		new Promise<false>((resolve) => {
			timeout = setTimeout(() => resolve(false), timeoutMs)
		}),
	])
	if (timeout !== null) {
		clearTimeout(timeout)
	}
	return settled
}

const readDiagnostic = async (
	stream: ReadableStream<Uint8Array>
): Promise<string> => {
	const reader = stream.getReader()
	const chunks: Uint8Array[] = []
	let length = 0
	try {
		while (length < MAXIMUM_DIAGNOSTIC_BYTES) {
			// biome-ignore lint/performance/noAwaitInLoops: Diagnostics arrive as a stream.
			const { done, value } = await reader.read()
			if (done) {
				break
			}
			const retained = value.subarray(
				0,
				Math.min(value.byteLength, MAXIMUM_DIAGNOSTIC_BYTES - length)
			)
			chunks.push(retained)
			length += retained.byteLength
		}
		if (length === MAXIMUM_DIAGNOSTIC_BYTES) {
			await reader.cancel()
		}
	} finally {
		reader.releaseLock()
	}
	const bytes = new Uint8Array(length)
	let offset = 0
	for (const chunk of chunks) {
		bytes.set(chunk, offset)
		offset += chunk.byteLength
	}
	return new TextDecoder().decode(bytes).trim()
}

interface StoppableProcess {
	exited: Promise<number>
	kill: (signal?: number) => void
}

const createProcessStopper = (
	subprocess: StoppableProcess
): (() => Promise<number>) => {
	let stopPromise: Promise<number> | null = null
	return () => {
		if (stopPromise) {
			return stopPromise
		}
		stopPromise = (async () => {
			subprocess.kill()
			if (
				!(await settlesWithin(subprocess.exited, PROCESS_TERMINATION_GRACE_MS))
			) {
				subprocess.kill(9)
			}
			return await subprocess.exited
		})()
		return stopPromise
	}
}

const audioDecodeFailure = (
	diagnostic: string,
	originalError?: unknown
): AudioPipelineError => {
	const cause = diagnostic
		? new Error(
				diagnostic,
				originalError === undefined ? undefined : { cause: originalError }
			)
		: originalError
	return new AudioPipelineError(
		'audio_decode_failed',
		'FFmpeg could not decode the audiobook audio.',
		cause === undefined ? undefined : { cause }
	)
}

export class FfmpegAudioTranscoder implements AudioTranscoder {
	private readonly executable: string

	constructor(executable: string) {
		this.executable = executable
	}

	async transcode(
		source: ReadableStream<Uint8Array>,
		signal: AbortSignal,
		onWindow: (window: AudioWindow) => Promise<void>,
		options?: AudioTranscodeOptions
	): Promise<AudioTranscodeResult> {
		throwIfAborted(signal)
		const localPath = options?.localPath
		const inputArguments = localPath
			? ['-protocol_whitelist', 'file', '-i', localPath]
			: ['-protocol_whitelist', 'cache,pipe', '-i', 'cache:pipe:0']
		const subprocess = spawn({
			cmd: [
				this.executable,
				'-hide_banner',
				'-loglevel',
				'error',
				'-nostdin',
				...inputArguments,
				'-map',
				'0:a:0',
				'-vn',
				'-sn',
				'-dn',
				'-ac',
				String(CHANNELS),
				'-ar',
				String(SAMPLE_RATE),
				'-c:a',
				'pcm_s16le',
				'-f',
				's16le',
				'pipe:1',
			],
			stderr: 'pipe',
			stdin: localPath ? 'ignore' : 'pipe',
			stdout: 'pipe',
		})
		const lifecycle = new AbortController()
		const stop = createProcessStopper(subprocess)
		const onAbort = (): void => {
			lifecycle.abort(signal.reason ?? abortError())
		}
		const onLifecycleAbort = (): void => {
			stop().catch(() => undefined)
		}
		if (signal.aborted) {
			onAbort()
		} else {
			signal.addEventListener('abort', onAbort, { once: true })
		}
		lifecycle.signal.addEventListener('abort', onLifecycleAbort, { once: true })
		const input = localPath
			? Promise.resolve(0)
			: pumpInput(source, subprocess.stdin as FileSink, lifecycle.signal)
		let inputFailure: unknown
		input.catch((error: unknown) => {
			inputFailure = error
			lifecycle.abort(asError(error))
		})
		const diagnostic = readDiagnostic(subprocess.stderr)
		try {
			const result = await transcodePcmWindows(
				subprocess.stdout,
				lifecycle.signal,
				onWindow
			)
			const inputByteLength = await input
			const [exitCode, errorText] = await Promise.all([
				subprocess.exited,
				diagnostic,
			])
			if (exitCode !== 0) {
				throw audioDecodeFailure(errorText)
			}
			if ((localPath || inputByteLength > 0) && result.durationMs === 0) {
				throw new AudioPipelineError(
					'audio_decode_empty',
					'FFmpeg decoded no audio samples from the audiobook.'
				)
			}
			return result
		} catch (value) {
			const pipelineFailedFromInput = inputFailure !== undefined
			lifecycle.abort(
				value instanceof Error ? value : new Error('Audio failed')
			)
			const exitCode = await stop()
			try {
				await input
			} catch {
				// The primary pipeline failure is reported below.
			}
			const errorText = await diagnostic.catch(() => '')
			if (signal.aborted) {
				throw abortError()
			}
			if (pipelineFailedFromInput && exitCode !== 0) {
				throw audioDecodeFailure(errorText, value)
			}
			throw value
		} finally {
			signal.removeEventListener('abort', onAbort)
			lifecycle.signal.removeEventListener('abort', onLifecycleAbort)
		}
	}
}

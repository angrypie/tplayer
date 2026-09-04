import { describe, expect, test } from 'bun:test'
import {
	COUCHSPEECH_MODEL,
	type ConnectInstalledOptions,
	type CouchSpeechClient,
	CouchSpeechError,
	type CouchSpeechTranscription,
	type CouchSpeechTranscriptionOptions,
	type CouchSpeechWav,
} from '@couchspeech/client'
import { CouchSpeechProvider } from './couchSpeechProvider'
import { SpeechProviderFailure } from './provider'

interface TranscriptionCall {
	options: CouchSpeechTranscriptionOptions | undefined
	wav: CouchSpeechWav
}

const fakeClient = (
	transcribe: (
		wav: CouchSpeechWav,
		options?: CouchSpeechTranscriptionOptions
	) => Promise<CouchSpeechTranscription>
): CouchSpeechClient => ({ transcribe }) as unknown as CouchSpeechClient

const providerOptions = (
	signal = new AbortController().signal
): { language: string; signal: AbortSignal; timeoutMs: number } => ({
	language: 'en',
	signal,
	timeoutMs: 12_345,
})

describe('CouchSpeech provider', () => {
	test('lazily connects, maps word timings, forwards options, and reuses its client', async () => {
		const connectionOptions: ConnectInstalledOptions[] = []
		const transcriptionCalls: TranscriptionCall[] = []
		const client = fakeClient((wav, requestOptions) => {
			transcriptionCalls.push({ options: requestOptions, wav })
			return Promise.resolve({
				inferenceMs: 17,
				language: 'en',
				text: 'Hello world!',
				wordTimings: [
					{
						confidence: 0.95,
						endMilliseconds: 420,
						startMilliseconds: 10,
						word: 'Hello',
					},
					{
						confidence: null,
						endMilliseconds: 800,
						startMilliseconds: 450,
						word: 'world',
					},
					{
						endMilliseconds: 810,
						startMilliseconds: 800,
						word: '!',
					},
				],
			})
		})
		const provider = new CouchSpeechProvider({
			connect: (connectOptions = {}) => {
				connectionOptions.push(connectOptions)
				return Promise.resolve(client)
			},
		})
		const { signal } = new AbortController()
		const speechOptions = providerOptions(signal)
		const firstWav = Uint8Array.of(1, 2, 3)

		expect(connectionOptions).toHaveLength(0)
		expect(provider.id).toBe('couchspeech')
		expect(provider.model).toBe(COUCHSPEECH_MODEL)
		await expect(provider.transcribe(firstWav, speechOptions)).resolves.toEqual(
			{
				language: 'en',
				words: [
					{ confidence: 0.95, endMs: 420, startMs: 10, text: 'Hello' },
					{ confidence: null, endMs: 800, startMs: 450, text: 'world' },
					{ endMs: 810, startMs: 800, text: '!' },
				],
			}
		)
		await provider.transcribe(Uint8Array.of(4), speechOptions)

		expect(connectionOptions).toEqual([
			{
				preflightTimeoutMs: 3000,
				requestTimeoutMs: 12_345,
				signal,
			},
		])
		expect(transcriptionCalls).toHaveLength(2)
		expect(transcriptionCalls[0]).toEqual({
			options: { language: 'en', signal, timeoutMs: 12_345 },
			wav: firstWav,
		})
	})

	test('caps the preflight timeout at the shorter request timeout', async () => {
		const connectionOptions: ConnectInstalledOptions[] = []
		const provider = new CouchSpeechProvider({
			connect: (connectOptions = {}) => {
				connectionOptions.push(connectOptions)
				return Promise.resolve(
					fakeClient(() =>
						Promise.resolve({
							inferenceMs: 0,
							text: '',
							wordTimings: [],
						})
					)
				)
			},
		})
		const { signal } = new AbortController()

		await provider.transcribe(new Uint8Array(), {
			signal,
			timeoutMs: 1200,
		})

		expect(connectionOptions).toEqual([
			{ preflightTimeoutMs: 1200, requestTimeoutMs: 1200, signal },
		])
	})

	test('rejects responses without the word timings required by captions', async () => {
		const provider = new CouchSpeechProvider({
			connect: async () =>
				fakeClient(() =>
					Promise.resolve({ inferenceMs: 1, text: 'No timings' })
				),
		})

		const transcription = provider.transcribe(
			new Uint8Array(),
			providerOptions()
		)
		await expect(transcription).rejects.toBeInstanceOf(SpeechProviderFailure)
		await expect(transcription).rejects.toMatchObject({
			ambiguous: false,
			code: 'timings_unavailable',
			retryable: false,
		})
	})

	test.each([
		['timeout', true, true],
		['transport_error', true, true],
		['cancelled', false, true],
		['not_running', false, true],
		['invalid_argument', false, false],
		['audio_too_large', false, false],
		['authentication_failed', false, false],
		['configuration_invalid', false, false],
		['invalid_response', false, false],
		['response_too_large', false, false],
	] as const)(
		'maps CouchSpeech %s failures without losing retry ambiguity',
		async (code, ambiguous, retryable) => {
			const provider = new CouchSpeechProvider({
				connect: async () =>
					fakeClient(() =>
						Promise.reject(new CouchSpeechError(code, 'SDK detail'))
					),
			})

			const transcription = provider.transcribe(
				new Uint8Array(),
				providerOptions()
			)
			await expect(transcription).rejects.toBeInstanceOf(SpeechProviderFailure)
			await expect(transcription).rejects.toMatchObject({
				ambiguous,
				code,
				retryable,
			})
		}
	)

	test.each([
		{
			code: 'invalid_request',
			message: "The language hint 'kk' is not supported.",
			parameter: 'file',
			retryable: false,
			status: 422,
		},
		{
			code: 'invalid_wav',
			message: 'The WAV recording contains a truncated RIFF chunk.',
			parameter: 'file',
			retryable: false,
			status: 422,
		},
		{
			code: 'audio_too_long',
			message: 'The audio window is too long.',
			parameter: 'file',
			retryable: false,
			status: 413,
		},
		{
			code: 'unsupported_audio',
			message: 'This audio encoding is not supported.',
			parameter: 'file',
			retryable: false,
			status: 422,
		},
	] as const)(
		'maps deterministic CouchSpeech $code failures to useful terminal errors',
		async ({ code, message, parameter, retryable, status }) => {
			const cause = new CouchSpeechError('server_error', message, {
				parameter,
				serverCode: code,
				status,
			})
			const provider = new CouchSpeechProvider({
				connect: async () => fakeClient(() => Promise.reject(cause)),
			})

			const transcription = provider.transcribe(
				new Uint8Array(),
				providerOptions()
			)
			await expect(transcription).rejects.toBeInstanceOf(SpeechProviderFailure)
			await expect(transcription).rejects.toMatchObject({
				ambiguous: false,
				cause,
				code,
				message,
				retryable,
			})
		}
	)

	test.each([
		{
			code: 'queue_full',
			message: 'CouchSpeech is busy. Retry the transcription shortly.',
			status: 429,
		},
		{
			code: 'worker_busy',
			message: 'CouchSpeech is busy. Retry the transcription shortly.',
			status: 409,
		},
		{
			code: 'worker_timeout',
			message: 'CouchSpeech timed out while transcribing this audio window.',
			status: 504,
		},
		{
			code: 'worker_startup_timeout',
			message: 'CouchSpeech timed out while starting its local speech worker.',
			status: 503,
		},
		{
			code: 'temporarily_unavailable',
			message: 'CouchSpeech is busy. Retry the transcription shortly.',
			status: 503,
		},
	] as const)(
		'maps transient CouchSpeech $code failures without marking a server response ambiguous',
		async ({ code, message, status }) => {
			const cause = new CouchSpeechError('server_error', 'Daemon detail', {
				serverCode: code,
				status,
			})
			const provider = new CouchSpeechProvider({
				connect: async () => fakeClient(() => Promise.reject(cause)),
			})

			await expect(
				provider.transcribe(new Uint8Array(), providerOptions())
			).rejects.toMatchObject({
				ambiguous: false,
				cause,
				code,
				message,
				retryable: true,
			})
		}
	)

	test('keeps unknown server details private while preserving them as the cause', async () => {
		const cause = new CouchSpeechError(
			'server_error',
			'Internal model path /private/model and implementation detail',
			{ serverCode: 'unrecognized_worker_error', status: 500 }
		)
		const provider = new CouchSpeechProvider({
			connect: async () => fakeClient(() => Promise.reject(cause)),
		})

		await expect(
			provider.transcribe(new Uint8Array(), providerOptions())
		).rejects.toMatchObject({
			ambiguous: false,
			cause,
			code: 'unrecognized_worker_error',
			message: 'CouchSpeech could not complete the transcription.',
			retryable: true,
		})
	})

	test('maps unknown failures to a retryable non-ambiguous provider error', async () => {
		const cause = new Error('unexpected SDK failure')
		const provider = new CouchSpeechProvider({
			connect: async () => fakeClient(() => Promise.reject(cause)),
		})

		await expect(
			provider.transcribe(new Uint8Array(), providerOptions())
		).rejects.toMatchObject({
			ambiguous: false,
			cause,
			code: 'provider_error',
			retryable: true,
		})
	})

	test('drops a failed cached client and reconnects on the next explicit attempt', async () => {
		let connectionCount = 0
		let firstClientCallCount = 0
		const firstClient = fakeClient(() => {
			firstClientCallCount += 1
			if (firstClientCallCount === 2) {
				return Promise.reject(
					new CouchSpeechError('transport_error', 'connection lost')
				)
			}
			return Promise.resolve({
				inferenceMs: 1,
				text: 'first',
				wordTimings: [],
			})
		})
		const secondClient = fakeClient(() =>
			Promise.resolve({
				inferenceMs: 1,
				text: 'second',
				wordTimings: [],
			})
		)
		const provider = new CouchSpeechProvider({
			connect: () => {
				connectionCount += 1
				return Promise.resolve(
					connectionCount === 1 ? firstClient : secondClient
				)
			},
		})

		await provider.transcribe(new Uint8Array(), providerOptions())
		await expect(
			provider.transcribe(new Uint8Array(), providerOptions())
		).rejects.toMatchObject({ code: 'transport_error' })
		await provider.transcribe(new Uint8Array(), providerOptions())

		expect(connectionCount).toBe(2)
	})

	test('reset quarantines a cached client before the next transcription', async () => {
		let connectionCount = 0
		const provider = new CouchSpeechProvider({
			connect: () => {
				connectionCount += 1
				return Promise.resolve(
					fakeClient(() =>
						Promise.resolve({
							inferenceMs: 1,
							text: '',
							wordTimings: [],
						})
					)
				)
			},
		})

		await provider.transcribe(new Uint8Array(), providerOptions())
		provider.reset()
		await provider.transcribe(new Uint8Array(), providerOptions())

		expect(connectionCount).toBe(2)
	})

	test('a connection completed after reset cannot replace the newer client', async () => {
		let connectionCount = 0
		let resolveOldConnection = (_client: CouchSpeechClient): void => undefined
		const oldConnection = new Promise<CouchSpeechClient>((resolve) => {
			resolveOldConnection = resolve
		})
		let newClientCalls = 0
		const newClient = fakeClient(() => {
			newClientCalls += 1
			return Promise.resolve({ inferenceMs: 1, text: '', wordTimings: [] })
		})
		const provider = new CouchSpeechProvider({
			connect: () => {
				connectionCount += 1
				return connectionCount === 1
					? oldConnection
					: Promise.resolve(newClient)
			},
		})
		const stale = provider.transcribe(new Uint8Array(), providerOptions())
		await Promise.resolve()

		provider.reset()
		await provider.transcribe(new Uint8Array(), providerOptions())
		resolveOldConnection(
			fakeClient(() =>
				Promise.resolve({ inferenceMs: 1, text: 'old', wordTimings: [] })
			)
		)

		await expect(stale).rejects.toMatchObject({ code: 'cancelled' })
		await provider.transcribe(new Uint8Array(), providerOptions())
		expect(connectionCount).toBe(2)
		expect(newClientCalls).toBe(2)
	})

	test('a stale transcription failure cannot clear the client connected after reset', async () => {
		let connectionCount = 0
		let rejectOld = (_error: Error): void => undefined
		let markOldStarted = (): void => undefined
		const oldStarted = new Promise<void>((resolve) => {
			markOldStarted = resolve
		})
		const oldClient = fakeClient(
			() =>
				new Promise<CouchSpeechTranscription>((_resolve, reject) => {
					rejectOld = reject
					markOldStarted()
				})
		)
		let newClientCalls = 0
		const newClient = fakeClient(() => {
			newClientCalls += 1
			return Promise.resolve({ inferenceMs: 1, text: '', wordTimings: [] })
		})
		const provider = new CouchSpeechProvider({
			connect: () => {
				connectionCount += 1
				return Promise.resolve(connectionCount === 1 ? oldClient : newClient)
			},
		})
		const stale = provider.transcribe(new Uint8Array(), providerOptions())
		await oldStarted

		provider.reset()
		await provider.transcribe(new Uint8Array(), providerOptions())
		rejectOld(new CouchSpeechError('transport_error', 'old connection failed'))

		await expect(stale).rejects.toMatchObject({ code: 'transport_error' })
		await provider.transcribe(new Uint8Array(), providerOptions())
		expect(connectionCount).toBe(2)
		expect(newClientCalls).toBe(2)
	})
})

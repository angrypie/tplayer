import {
	COUCHSPEECH_MODEL,
	type CouchSpeechClient,
	connectInstalled,
	isCouchSpeechError,
} from '@couchspeech/client'
import {
	type SpeechProvider,
	SpeechProviderFailure,
	type SpeechTranscription,
	type SpeechTranscriptionOptions,
} from './provider'

type CouchSpeechConnector = typeof connectInstalled

const AMBIGUOUS_CODES = new Set(['timeout', 'transport_error'])
const NON_RETRYABLE_CODES = new Set([
	'audio_too_large',
	'authentication_failed',
	'configuration_insecure',
	'configuration_invalid',
	'configuration_not_found',
	'incompatible_service',
	'invalid_argument',
	'invalid_response',
	'redirect_rejected',
	'response_too_large',
])

const RETRYABLE_SERVER_CODES = new Set([
	'busy',
	'overloaded',
	'queue_full',
	'request_cancelled',
	'temporarily_unavailable',
	'worker_busy',
	'worker_failed',
	'worker_startup_timeout',
	'worker_timeout',
])

const PUBLIC_SERVER_MESSAGE_CODES = new Set([
	'audio_limit_exceeded',
	'audio_too_large',
	'audio_too_long',
	'audio_too_short',
	'empty_audio',
	'invalid_request',
	'invalid_wav',
	'missing_model',
	'model_not_found',
	'unsupported_content_type',
	'unsupported_audio',
	'unsupported_language',
	'unsupported_model',
	'unsupported_response_format',
])

const safeServerMessage = (message: string): string => {
	let normalized = ''
	for (const character of message.slice(0, 1024)) {
		const codePoint = character.codePointAt(0)
		normalized +=
			codePoint !== undefined && (codePoint < 32 || codePoint === 127)
				? ' '
				: character
	}
	return normalized.trim().slice(0, 512)
}

const serverFailure = (value: {
	message: string
	parameter?: string | null
	serverCode?: string
	status?: number
}): SpeechProviderFailure => {
	const { serverCode, status } = value
	const code = serverCode ?? 'server_error'
	const retryable =
		RETRYABLE_SERVER_CODES.has(code) ||
		status === 408 ||
		status === 425 ||
		status === 429 ||
		(status !== undefined && status >= 500)
	let message: string
	if (PUBLIC_SERVER_MESSAGE_CODES.has(code)) {
		message =
			safeServerMessage(value.message) ||
			'CouchSpeech rejected this audio window.'
	} else {
		switch (code) {
			case 'busy':
			case 'overloaded':
			case 'queue_full':
			case 'temporarily_unavailable':
			case 'worker_busy':
				message = 'CouchSpeech is busy. Retry the transcription shortly.'
				break
			case 'request_cancelled':
				message = 'CouchSpeech cancelled the transcription request.'
				break
			case 'worker_startup_timeout':
				message =
					'CouchSpeech timed out while starting its local speech worker.'
				break
			case 'worker_timeout':
				message = 'CouchSpeech timed out while transcribing this audio window.'
				break
			case 'encoding_failed':
				message = 'CouchSpeech could not return the transcription result.'
				break
			case 'inference_failed':
			case 'worker_failed':
				message =
					'CouchSpeech\u2019s local speech worker could not complete this audio window.'
				break
			default:
				message = 'CouchSpeech could not complete the transcription.'
		}
	}
	return new SpeechProviderFailure(code, message, {
		ambiguous: false,
		cause: value,
		retryable,
	})
}

const clientFailureMessage = (code: string, detail: string): string => {
	switch (code) {
		case 'cancelled':
			return 'CouchSpeech transcription was cancelled.'
		case 'not_running':
			return 'CouchSpeech is not running. Start CouchSpeech and retry transcription.'
		case 'timeout':
			return 'The CouchSpeech request timed out and may have completed.'
		case 'transport_error':
			return 'The connection to CouchSpeech was interrupted; the request may have completed.'
		default:
			return (
				safeServerMessage(detail) ||
				'CouchSpeech could not complete the transcription.'
			)
	}
}

const providerFailure = (value: unknown): SpeechProviderFailure => {
	if (!isCouchSpeechError(value)) {
		return new SpeechProviderFailure(
			'provider_error',
			'CouchSpeech could not complete the transcription.',
			{ cause: value }
		)
	}
	if (value.code === 'server_error') {
		return serverFailure(value)
	}
	const ambiguous = AMBIGUOUS_CODES.has(value.code)
	const retryable = !NON_RETRYABLE_CODES.has(value.code)
	return new SpeechProviderFailure(
		value.code,
		clientFailureMessage(value.code, value.message),
		{ ambiguous, cause: value, retryable }
	)
}

export interface CouchSpeechProviderOptions {
	connect?: CouchSpeechConnector
}

export class CouchSpeechProvider implements SpeechProvider {
	readonly id = 'couchspeech'
	readonly model = COUCHSPEECH_MODEL

	private client: CouchSpeechClient | null = null
	private readonly connect: CouchSpeechConnector
	private generation = 0

	constructor({ connect = connectInstalled }: CouchSpeechProviderOptions = {}) {
		this.connect = connect
	}

	reset(): void {
		this.generation += 1
		this.client = null
	}

	async transcribe(
		wav: Uint8Array,
		options: SpeechTranscriptionOptions
	): Promise<SpeechTranscription> {
		const { generation } = this
		let client: CouchSpeechClient | null = null
		try {
			client = await this.connectedClient(options, generation)
			const result = await client.transcribe(wav, {
				...(options.language ? { language: options.language } : {}),
				signal: options.signal,
				timeoutMs: options.timeoutMs,
			})
			if (!result.wordTimings) {
				throw new SpeechProviderFailure(
					'timings_unavailable',
					'CouchSpeech did not return the word timings required for captions.',
					{ retryable: false }
				)
			}
			return {
				...(result.language ? { language: result.language } : {}),
				words: result.wordTimings.map((timing) => ({
					...(timing.confidence === undefined
						? {}
						: { confidence: timing.confidence }),
					endMs: timing.endMilliseconds,
					startMs: timing.startMilliseconds,
					text: timing.word,
				})),
			}
		} catch (value) {
			if (value instanceof SpeechProviderFailure) {
				throw value
			}
			if (
				this.generation === generation &&
				(client === null || this.client === client)
			) {
				this.generation += 1
				this.client = null
			}
			throw providerFailure(value)
		}
	}

	private async connectedClient(
		options: SpeechTranscriptionOptions,
		generation: number
	): Promise<CouchSpeechClient> {
		if (this.client && generation === this.generation) {
			return this.client
		}
		const candidate = await this.connect({
			preflightTimeoutMs: Math.min(options.timeoutMs, 3000),
			requestTimeoutMs: options.timeoutMs,
			signal: options.signal,
		})
		if (generation !== this.generation) {
			throw new SpeechProviderFailure(
				'cancelled',
				'CouchSpeech connection was replaced before it became ready.'
			)
		}
		this.client = candidate
		return candidate
	}
}

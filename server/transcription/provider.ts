import type { TimedWord } from '@tplayer/captions/types'

export interface SpeechTranscription {
	language?: string
	words: readonly TimedWord[]
}

export interface SpeechTranscriptionOptions {
	language?: string
	signal: AbortSignal
	timeoutMs: number
}

export interface SpeechProvider {
	readonly id: string
	readonly model: string
	reset?: () => void
	transcribe: (
		wav: Uint8Array,
		options: SpeechTranscriptionOptions
	) => Promise<SpeechTranscription>
}

export interface SpeechProviderFailureOptions extends ErrorOptions {
	ambiguous?: boolean
	retryable?: boolean
}

export class SpeechProviderFailure extends Error {
	readonly ambiguous: boolean
	readonly code: string
	readonly retryable: boolean

	constructor(
		code: string,
		message: string,
		{
			ambiguous = false,
			retryable = true,
			...options
		}: SpeechProviderFailureOptions = {}
	) {
		super(message, options)
		this.name = 'SpeechProviderFailure'
		this.ambiguous = ambiguous
		this.code = code
		this.retryable = retryable
	}
}

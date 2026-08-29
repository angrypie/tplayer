export type HttpStatus =
	| 400
	| 404
	| 409
	| 416
	| 422
	| 499
	| 500
	| 502
	| 503
	| 504

export class HttpError extends Error {
	readonly code: string
	readonly headers: Readonly<Record<string, string>>
	readonly status: HttpStatus

	constructor(
		status: HttpStatus,
		code: string,
		message: string,
		headers: Readonly<Record<string, string>> = {},
		options?: ErrorOptions
	) {
		super(message, options)
		this.name = 'HttpError'
		this.code = code
		this.headers = headers
		this.status = status
	}
}

export const asError = (value: unknown): Error =>
	value instanceof Error ? value : new Error(String(value))

export type SettingsRequestOperation = 'read' | 'write'

interface SettingsRequestOptions {
	signal?: AbortSignal
	timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 15_000

const physicalRequests = new WeakMap<
	object,
	Map<SettingsRequestOperation, Promise<unknown>>
>()

export class SettingsRequestBusyError extends Error {
	readonly operation: SettingsRequestOperation

	constructor(operation: SettingsRequestOperation) {
		super(
			`The previous transcription settings ${operation} request is still settling.`
		)
		this.name = 'SettingsRequestBusyError'
		this.operation = operation
	}
}

export class SettingsRequestTimeoutError extends Error {
	constructor() {
		super('Transcription settings request timed out.')
		this.name = 'SettingsRequestTimeoutError'
	}
}

const requestRegistry = (
	owner: object
): Map<SettingsRequestOperation, Promise<unknown>> => {
	const current = physicalRequests.get(owner)
	if (current) {
		return current
	}
	const created = new Map<SettingsRequestOperation, Promise<unknown>>()
	physicalRequests.set(owner, created)
	return created
}

const abortError = (signal: AbortSignal): Error => {
	if (signal.reason instanceof Error) {
		return signal.reason
	}
	return new DOMException(
		'Transcription settings request aborted',
		'AbortError'
	)
}

/**
 * Bounds the UI wait without pretending an abort-ignoring transport has
 * stopped. The physical request remains quarantined until it really settles,
 * so remounts and retries cannot accumulate duplicate reads or writes.
 */
export const boundedSettingsRequest = async <Value>(
	owner: object,
	requestOperation: SettingsRequestOperation,
	request: (signal: AbortSignal) => Promise<Value>,
	options: SettingsRequestOptions = {}
): Promise<Value> => {
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
	if (!(Number.isFinite(timeoutMs) && timeoutMs > 0)) {
		throw new RangeError('Settings request timeout must be positive')
	}
	if (options.signal?.aborted) {
		throw abortError(options.signal)
	}

	const registry = requestRegistry(owner)
	if (registry.has(requestOperation)) {
		throw new SettingsRequestBusyError(requestOperation)
	}

	const controller = new AbortController()
	const physicalRequest = Promise.resolve().then(() =>
		request(controller.signal)
	)
	registry.set(requestOperation, physicalRequest)
	const release = (): void => {
		if (registry.get(requestOperation) === physicalRequest) {
			registry.delete(requestOperation)
		}
	}
	physicalRequest.then(release, release)

	let rejectBoundary = (_error: Error): void => undefined
	const boundary = new Promise<never>((_resolve, reject) => {
		rejectBoundary = reject
	})
	const forwardAbort = (): void => {
		const error = options.signal
			? abortError(options.signal)
			: new DOMException('Transcription settings request aborted', 'AbortError')
		controller.abort(error)
		rejectBoundary(error)
	}
	options.signal?.addEventListener('abort', forwardAbort, { once: true })
	const timeout = setTimeout(() => {
		const error = new SettingsRequestTimeoutError()
		controller.abort(error)
		rejectBoundary(error)
	}, timeoutMs)

	try {
		return await Promise.race([physicalRequest, boundary])
	} finally {
		clearTimeout(timeout)
		options.signal?.removeEventListener('abort', forwardAbort)
	}
}

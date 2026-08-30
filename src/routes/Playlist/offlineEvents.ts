const OFFLINE_CHANGE_CHANNEL = 'tplayer:offline-change:v1'
const OFFLINE_CHANGE_STORAGE_KEY = 'tplayer:offline-change-event:v1'

export interface OfflineChange {
	infoHash: string
	kind: 'removed' | 'updated'
	path?: string
}

type OfflineChangeListener = (change: OfflineChange) => void

interface OfflineChangeEnvelope {
	change: OfflineChange
	id: string
}

const listeners = new Set<OfflineChangeListener>()
const seenEventIds = new Set<string>()
let channel: BroadcastChannel | null = null
let channelUnavailable = false
let storageListenerInstalled = false

const normalizeChange = (value: unknown): OfflineChange | null => {
	if (!(typeof value === 'object' && value !== null)) {
		return null
	}
	const candidate = value as {
		infoHash?: unknown
		kind?: unknown
		path?: unknown
	}
	if (
		typeof candidate.infoHash !== 'string' ||
		candidate.infoHash.length === 0
	) {
		return null
	}
	if (candidate.kind !== 'removed' && candidate.kind !== 'updated') {
		return null
	}
	if (candidate.path !== undefined && typeof candidate.path !== 'string') {
		return null
	}
	return {
		infoHash: candidate.infoHash.toLowerCase(),
		kind: candidate.kind,
		...(candidate.path === undefined ? {} : { path: candidate.path }),
	}
}

const notifyListeners = (change: OfflineChange): void => {
	for (const listener of listeners) {
		listener(change)
	}
}

const normalizeEnvelope = (value: unknown): OfflineChangeEnvelope | null => {
	if (!(typeof value === 'object' && value !== null)) {
		return null
	}
	const candidate = value as { change?: unknown; id?: unknown }
	const change = normalizeChange(candidate.change)
	if (
		!(change && typeof candidate.id === 'string' && candidate.id.length > 0)
	) {
		return null
	}
	return { change, id: candidate.id }
}

const rememberEvent = (id: string): boolean => {
	if (seenEventIds.has(id)) {
		return false
	}
	seenEventIds.add(id)
	if (seenEventIds.size > 128) {
		const oldest = seenEventIds.values().next().value
		if (oldest) {
			seenEventIds.delete(oldest)
		}
	}
	return true
}

const receiveEnvelope = (value: unknown): void => {
	const envelope = normalizeEnvelope(value)
	if (envelope && rememberEvent(envelope.id)) {
		notifyListeners(envelope.change)
	}
}

const getChannel = (): BroadcastChannel | null => {
	if (
		channel ||
		channelUnavailable ||
		typeof window === 'undefined' ||
		typeof BroadcastChannel === 'undefined'
	) {
		return channel
	}
	try {
		channel = new BroadcastChannel(OFFLINE_CHANGE_CHANNEL)
		channel.addEventListener('message', (event: MessageEvent<unknown>) => {
			receiveEnvelope(event.data)
		})
	} catch {
		channelUnavailable = true
	}
	return channel
}

const installStorageFallback = (): void => {
	if (storageListenerInstalled || typeof window === 'undefined') {
		return
	}
	window.addEventListener('storage', (event) => {
		if (event.key !== OFFLINE_CHANGE_STORAGE_KEY || event.newValue === null) {
			return
		}
		try {
			receiveEnvelope(JSON.parse(event.newValue) as unknown)
		} catch {
			// Ignore malformed or unavailable cross-tab storage messages.
		}
	})
	storageListenerInstalled = true
}

const publishStorageFallback = (envelope: OfflineChangeEnvelope): void => {
	if (typeof window === 'undefined') {
		return
	}
	try {
		window.localStorage.setItem(
			OFFLINE_CHANGE_STORAGE_KEY,
			JSON.stringify(envelope)
		)
		window.localStorage.removeItem(OFFLINE_CHANGE_STORAGE_KEY)
	} catch {
		// The local tab is already reconciled; unavailable storage cannot be used as a transport.
	}
}

export const publishOfflineChange = (change: OfflineChange): void => {
	const normalized = normalizeChange(change)
	if (!normalized) {
		return
	}
	notifyListeners(normalized)
	const envelope = { change: normalized, id: crypto.randomUUID() }
	rememberEvent(envelope.id)
	const activeChannel = getChannel()
	if (activeChannel) {
		activeChannel.postMessage(envelope)
	}
	installStorageFallback()
	publishStorageFallback(envelope)
}

export const subscribeToOfflineChanges = (
	listener: OfflineChangeListener
): (() => void) => {
	listeners.add(listener)
	getChannel()
	installStorageFallback()
	return () => {
		listeners.delete(listener)
	}
}

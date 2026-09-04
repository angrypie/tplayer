const LIVE_CAPTIONS_PREFERENCE_KEY = 'tplayer:live-captions:v1'
const LIVE_CAPTIONS_PREFERENCE_VERSION = 1

const browserStorage = (): Storage | null => {
	if (typeof window === 'undefined') {
		return null
	}
	try {
		return window.localStorage
	} catch {
		return null
	}
}

export const loadLiveCaptionsPreference = (
	storage: Storage | null = browserStorage()
): boolean => {
	if (!storage) {
		return false
	}
	try {
		const serialized = storage.getItem(LIVE_CAPTIONS_PREFERENCE_KEY)
		if (!serialized) {
			return false
		}
		const value = JSON.parse(serialized) as unknown
		if (
			!(typeof value === 'object' && value !== null && !Array.isArray(value))
		) {
			return false
		}
		const preference = value as { enabled?: unknown; version?: unknown }
		return (
			preference.version === LIVE_CAPTIONS_PREFERENCE_VERSION &&
			preference.enabled === true
		)
	} catch {
		return false
	}
}

export const saveLiveCaptionsPreference = (
	enabled: boolean,
	storage: Storage | null = browserStorage()
): boolean => {
	if (!storage) {
		return false
	}
	try {
		storage.setItem(
			LIVE_CAPTIONS_PREFERENCE_KEY,
			JSON.stringify({
				enabled: Boolean(enabled),
				version: LIVE_CAPTIONS_PREFERENCE_VERSION,
			})
		)
		return true
	} catch {
		return false
	}
}

export { LIVE_CAPTIONS_PREFERENCE_KEY, LIVE_CAPTIONS_PREFERENCE_VERSION }

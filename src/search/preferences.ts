import type { SearchProviderDescriptor } from './types'

const SEARCH_PREFERENCES_KEY = 'tplayer:search-provider-preferences'

export interface SearchPreferences {
	enabledOptionalProviderIds: string[]
}

const EMPTY_PREFERENCES: SearchPreferences = {
	enabledOptionalProviderIds: [],
}

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

const normalizeProviderIds = (value: unknown): string[] => {
	if (!Array.isArray(value)) {
		return []
	}
	const providerIds = value.filter(
		(entry): entry is string =>
			typeof entry === 'string' && entry.trim().length > 0
	)
	return [...new Set(providerIds.map((providerId) => providerId.trim()))].sort()
}

export const enabledTrackerProviderIds = (
	preferences: SearchPreferences,
	providers: readonly SearchProviderDescriptor[]
): string[] => {
	const trackerIds = new Set(
		providers
			.filter((provider) => provider.kind === 'tracker')
			.map((provider) => provider.id)
	)
	return normalizeProviderIds(preferences.enabledOptionalProviderIds).filter(
		(providerId) => trackerIds.has(providerId)
	)
}

export const loadSearchPreferences = (
	storage: Storage | null = browserStorage()
): SearchPreferences => {
	if (!storage) {
		return EMPTY_PREFERENCES
	}
	try {
		const serialized = storage.getItem(SEARCH_PREFERENCES_KEY)
		if (!serialized) {
			return EMPTY_PREFERENCES
		}
		const value = JSON.parse(serialized) as unknown
		if (typeof value !== 'object' || value === null || Array.isArray(value)) {
			return EMPTY_PREFERENCES
		}
		const { enabledOptionalProviderIds } = value as Record<string, unknown>
		return {
			enabledOptionalProviderIds: normalizeProviderIds(
				enabledOptionalProviderIds
			),
		}
	} catch {
		return EMPTY_PREFERENCES
	}
}

export const saveSearchPreferences = (
	preferences: SearchPreferences,
	storage: Storage | null = browserStorage()
): boolean => {
	if (!storage) {
		return false
	}
	try {
		storage.setItem(
			SEARCH_PREFERENCES_KEY,
			JSON.stringify({
				enabledOptionalProviderIds: normalizeProviderIds(
					preferences.enabledOptionalProviderIds
				),
			})
		)
		return true
	} catch {
		return false
	}
}

export { SEARCH_PREFERENCES_KEY }

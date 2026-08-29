import { CONTENT_USE_POLICY_VERSION } from './contentPolicy'
import type { SearchProviderDescriptor } from './types'

const SEARCH_PREFERENCES_KEY = 'tplayer:search-provider-preferences'

export interface SearchPreferences {
	contentPolicyAcknowledgedVersion: number | null
	enabledOptionalProviderIds: string[]
}

const EMPTY_PREFERENCES: SearchPreferences = {
	contentPolicyAcknowledgedVersion: null,
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

const acknowledgedPolicyVersion = (value: unknown): number | null =>
	typeof value === 'number' && Number.isInteger(value) && value > 0
		? value
		: null

export const hasCurrentContentPolicyAcknowledgement = (
	preferences: SearchPreferences
): boolean =>
	preferences.contentPolicyAcknowledgedVersion === CONTENT_USE_POLICY_VERSION

export const enabledTrackerProviderIds = (
	preferences: SearchPreferences,
	providers: readonly SearchProviderDescriptor[]
): string[] => {
	if (!hasCurrentContentPolicyAcknowledgement(preferences)) {
		return []
	}
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
		const { contentPolicyAcknowledgedVersion, enabledOptionalProviderIds } =
			value as Record<string, unknown>
		return {
			contentPolicyAcknowledgedVersion: acknowledgedPolicyVersion(
				contentPolicyAcknowledgedVersion
			),
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
		const contentPolicyAcknowledgedVersion = acknowledgedPolicyVersion(
			preferences.contentPolicyAcknowledgedVersion
		)
		const enabledOptionalProviderIds =
			contentPolicyAcknowledgedVersion === CONTENT_USE_POLICY_VERSION
				? normalizeProviderIds(preferences.enabledOptionalProviderIds)
				: []
		storage.setItem(
			SEARCH_PREFERENCES_KEY,
			JSON.stringify({
				contentPolicyAcknowledgedVersion,
				enabledOptionalProviderIds,
			})
		)
		return true
	} catch {
		return false
	}
}

export { SEARCH_PREFERENCES_KEY }

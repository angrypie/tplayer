import { describe, expect, test } from 'bun:test'
import { CONTENT_USE_POLICY_VERSION } from './contentPolicy'
import {
	enabledTrackerProviderIds,
	hasCurrentContentPolicyAcknowledgement,
	loadSearchPreferences,
	SEARCH_PREFERENCES_KEY,
	saveSearchPreferences,
} from './preferences'
import type { SearchProviderDescriptor } from './types'

class MemoryStorage implements Storage {
	private readonly values = new Map<string, string>()

	get length(): number {
		return this.values.size
	}

	clear(): void {
		this.values.clear()
	}

	getItem(key: string): string | null {
		return this.values.get(key) ?? null
	}

	key(index: number): string | null {
		return [...this.values.keys()][index] ?? null
	}

	removeItem(key: string): void {
		this.values.delete(key)
	}

	setItem(key: string, value: string): void {
		this.values.set(key, value)
	}
}

const providers: SearchProviderDescriptor[] = [
	{
		defaultEnabled: true,
		homepage: 'https://librivox.org',
		id: 'librivox',
		kind: 'free',
		label: 'LibriVox',
		rights: 'public-domain-source',
	},
	{
		defaultEnabled: false,
		homepage: 'https://audiobookbay.lu',
		id: 'audiobook-bay',
		kind: 'tracker',
		label: 'AudioBookBay',
		rights: 'unverified-third-party',
	},
]

describe('search provider preferences', () => {
	test('fails closed for a legacy enabled tracker without a policy acknowledgement', () => {
		const storage = new MemoryStorage()
		storage.setItem(
			SEARCH_PREFERENCES_KEY,
			JSON.stringify({ enabledOptionalProviderIds: ['audiobook-bay'] })
		)

		const preferences = loadSearchPreferences(storage)

		expect(preferences).toEqual({
			contentPolicyAcknowledgedVersion: null,
			enabledOptionalProviderIds: ['audiobook-bay'],
		})
		expect(hasCurrentContentPolicyAcknowledgement(preferences)).toBe(false)
		expect(enabledTrackerProviderIds(preferences, providers)).toEqual([])
	})

	test.each([
		['stale', CONTENT_USE_POLICY_VERSION - 1],
		['future', CONTENT_USE_POLICY_VERSION + 1],
		['fractional', CONTENT_USE_POLICY_VERSION + 0.5],
		['string', String(CONTENT_USE_POLICY_VERSION)],
	])('rejects a %s policy version', (_label, version) => {
		const storage = new MemoryStorage()
		storage.setItem(
			SEARCH_PREFERENCES_KEY,
			JSON.stringify({
				contentPolicyAcknowledgedVersion: version,
				enabledOptionalProviderIds: ['audiobook-bay'],
			})
		)

		const preferences = loadSearchPreferences(storage)

		expect(enabledTrackerProviderIds(preferences, providers)).toEqual([])
	})

	test('round-trips current acknowledgement and normalizes supported tracker choices', () => {
		const storage = new MemoryStorage()
		const saved = saveSearchPreferences(
			{
				contentPolicyAcknowledgedVersion: CONTENT_USE_POLICY_VERSION,
				enabledOptionalProviderIds: [
					'audiobook-bay',
					' audiobook-bay ',
					'removed-provider',
				],
			},
			storage
		)

		const loaded = loadSearchPreferences(storage)

		expect(saved).toBe(true)
		expect(hasCurrentContentPolicyAcknowledgement(loaded)).toBe(true)
		expect(loaded.enabledOptionalProviderIds).toEqual([
			'audiobook-bay',
			'removed-provider',
		])
		expect(enabledTrackerProviderIds(loaded, providers)).toEqual([
			'audiobook-bay',
		])
	})

	test('never persists enabled trackers without the current acknowledgement', () => {
		const storage = new MemoryStorage()

		expect(
			saveSearchPreferences(
				{
					contentPolicyAcknowledgedVersion: null,
					enabledOptionalProviderIds: ['audiobook-bay'],
				},
				storage
			)
		).toBe(true)
		expect(JSON.parse(storage.getItem(SEARCH_PREFERENCES_KEY) ?? '')).toEqual({
			contentPolicyAcknowledgedVersion: null,
			enabledOptionalProviderIds: [],
		})
	})

	test('reports storage failure instead of claiming the setting was saved', () => {
		const storage = new MemoryStorage()
		storage.setItem = () => {
			throw new Error('storage unavailable')
		}

		expect(
			saveSearchPreferences(
				{
					contentPolicyAcknowledgedVersion: CONTENT_USE_POLICY_VERSION,
					enabledOptionalProviderIds: ['audiobook-bay'],
				},
				storage
			)
		).toBe(false)
	})
})

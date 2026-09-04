import { describe, expect, test } from 'bun:test'
import {
	LIVE_CAPTIONS_PREFERENCE_KEY,
	LIVE_CAPTIONS_PREFERENCE_VERSION,
	loadLiveCaptionsPreference,
	saveLiveCaptionsPreference,
} from './livePreference'

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

describe('live captions preference', () => {
	test('defaults off and rejects malformed or stale values', () => {
		const storage = new MemoryStorage()
		expect(loadLiveCaptionsPreference(storage)).toBe(false)

		storage.setItem(LIVE_CAPTIONS_PREFERENCE_KEY, '{broken')
		expect(loadLiveCaptionsPreference(storage)).toBe(false)

		storage.setItem(
			LIVE_CAPTIONS_PREFERENCE_KEY,
			JSON.stringify({ enabled: true, version: 0 })
		)
		expect(loadLiveCaptionsPreference(storage)).toBe(false)
	})

	test('round-trips the independent enabled state', () => {
		const storage = new MemoryStorage()
		expect(saveLiveCaptionsPreference(true, storage)).toBe(true)
		expect(loadLiveCaptionsPreference(storage)).toBe(true)
		expect(
			JSON.parse(storage.getItem(LIVE_CAPTIONS_PREFERENCE_KEY) ?? '')
		).toEqual({ enabled: true, version: LIVE_CAPTIONS_PREFERENCE_VERSION })

		expect(saveLiveCaptionsPreference(false, storage)).toBe(true)
		expect(loadLiveCaptionsPreference(storage)).toBe(false)
	})

	test('reports storage failure without enabling by default', () => {
		const storage = new MemoryStorage()
		storage.setItem = () => {
			throw new DOMException('Storage unavailable', 'QuotaExceededError')
		}
		expect(saveLiveCaptionsPreference(true, storage)).toBe(false)
		expect(loadLiveCaptionsPreference(storage)).toBe(false)
	})
})

import { describe, expect, test } from 'bun:test'
import {
	boundedSettingsRequest,
	SettingsRequestBusyError,
	SettingsRequestTimeoutError,
} from './settingsRequests'

describe('bounded transcription settings requests', () => {
	test('times out an abort-ignoring request and quarantines it across callers', async () => {
		const owner = {}
		let calls = 0
		let requestSignal: AbortSignal | null = null
		let settleRequest = (): void => undefined
		const ignoredRequest = (signal: AbortSignal): Promise<string> => {
			calls += 1
			requestSignal = signal
			return new Promise((resolve) => {
				settleRequest = () => resolve('late result')
			})
		}

		await expect(
			boundedSettingsRequest(owner, 'read', ignoredRequest, { timeoutMs: 10 })
		).rejects.toBeInstanceOf(SettingsRequestTimeoutError)
		expect((requestSignal as AbortSignal | null)?.aborted).toBe(true)
		expect(calls).toBe(1)

		await expect(
			boundedSettingsRequest(owner, 'read', ignoredRequest, { timeoutMs: 10 })
		).rejects.toBeInstanceOf(SettingsRequestBusyError)
		expect(calls).toBe(1)

		settleRequest()
		await new Promise<void>((resolve) => {
			setTimeout(resolve, 0)
		})
		await expect(
			boundedSettingsRequest(
				owner,
				'read',
				() => Promise.resolve('recovered'),
				{ timeoutMs: 10 }
			)
		).resolves.toBe('recovered')
	})

	test('bounds an unmount even when the request ignores cancellation', async () => {
		const controller = new AbortController()
		const owner = {}
		let calls = 0
		const result = boundedSettingsRequest(
			owner,
			'write',
			() => {
				calls += 1
				return new Promise<boolean>(() => undefined)
			},
			{ signal: controller.signal, timeoutMs: 1000 }
		)
		controller.abort(new Error('Settings view unmounted'))

		await expect(result).rejects.toThrow('Settings view unmounted')
		expect(calls).toBe(1)
		await expect(
			boundedSettingsRequest(owner, 'write', () => Promise.resolve(true), {
				timeoutMs: 10,
			})
		).rejects.toBeInstanceOf(SettingsRequestBusyError)
	})

	test('allows one read and one write to settle independently', async () => {
		const owner = {}
		const [read, write] = await Promise.all([
			boundedSettingsRequest(owner, 'read', () => Promise.resolve('read')),
			boundedSettingsRequest(owner, 'write', () => Promise.resolve('write')),
		])
		expect(read).toBe('read')
		expect(write).toBe('write')
	})
})

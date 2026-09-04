import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import {
	CaptionProgress,
	captionProgressModel,
	resolveCaptionProgressTotal,
} from './CaptionProgress'

describe('caption transcription progress', () => {
	test('reports deterministic percentage and elapsed chapter time', () => {
		expect(captionProgressModel(61_250, 245_000)).toEqual({
			detail: '1:01 of 4:05',
			percentage: 25,
			percentageLabel: '25%',
			valueText: '25% complete, 1:01 of 4:05',
		})
	})

	test('keeps early progress visible for long chapters', () => {
		expect(captionProgressModel(90_000, 24_156_000)).toEqual({
			detail: '1:30 of 6:42:36',
			percentage: 0.4,
			percentageLabel: '0.4%',
			valueText: '0.4% complete, 1:30 of 6:42:36',
		})
	})

	test('clamps progress into the valid range', () => {
		expect(captionProgressModel(-500, 1000).percentage).toBe(0)
		expect(captionProgressModel(1500, 1000)).toEqual({
			detail: '0:01 of 0:01',
			percentage: 100,
			percentageLabel: '100%',
			valueText: '100% complete, 0:01 of 0:01',
		})
	})

	test('reports elapsed transcription time when no total is available', () => {
		expect(captionProgressModel(90_000, undefined)).toEqual({
			detail: '1:30 transcribed',
			valueText: '1:30 transcribed; the total duration is not known yet.',
		})
	})

	test('uses a loaded player duration only when the server total is unknown', () => {
		expect(resolveCaptionProgressTotal('transcribing', 80_000, true, 90)).toBe(
			80_000
		)
		expect(
			resolveCaptionProgressTotal('transcribing', undefined, true, 90)
		).toBe(90_000)
		expect(
			resolveCaptionProgressTotal('transcribing', undefined, false, 1)
		).toBeUndefined()
		expect(
			resolveCaptionProgressTotal('transcribing', undefined, true, Number.NaN)
		).toBeUndefined()
	})

	test('keeps queued and preparing work indeterminate', () => {
		expect(
			resolveCaptionProgressTotal('queued', 80_000, true, 90)
		).toBeUndefined()
		expect(
			resolveCaptionProgressTotal('preparing', 80_000, true, 90)
		).toBeUndefined()
	})

	test('renders an accessible indeterminate state before duration is known', () => {
		const markup = renderToStaticMarkup(
			<CaptionProgress processedMilliseconds={0} />
		)
		expect(markup).toContain('data-caption-progress="indeterminate"')
		expect(markup).toContain('aria-label="Transcription progress"')
		expect(markup).toContain('Progress pending…')
		expect(markup).not.toContain('value="')
	})

	test('renders queued work as waiting without an activity pulse', () => {
		const markup = renderToStaticMarkup(
			<CaptionProgress processedMilliseconds={0} state='queued' />
		)
		expect(markup).toContain('data-caption-stage="queued"')
		expect(markup).toContain('Waiting')
		expect(markup).toContain('Queued for transcription')
		expect(markup).toContain('Waiting for transcription to start.')
		expect(markup).not.toContain('animate-pulse')
	})

	test('explains when the queue is paused for physical cleanup', () => {
		const markup = renderToStaticMarkup(
			<CaptionProgress
				processedMilliseconds={0}
				queueBlockedByCleanup
				state='queued'
			/>
		)
		expect(markup).toContain('Queue paused')
		expect(markup).toContain('Waiting for cleanup')
		expect(markup).toContain(
			'Waiting for the previous chapter to release local resources.'
		)
		expect(markup).not.toContain('animate-pulse')
	})

	test('labels local audio preparation explicitly', () => {
		const markup = renderToStaticMarkup(
			<CaptionProgress processedMilliseconds={0} state='preparing' />
		)
		expect(markup).toContain('data-caption-stage="preparing"')
		expect(markup).toContain('Preparing local audio')
		expect(markup).not.toContain('In progress')
	})

	test('renders the determinate value for assistive technology', () => {
		const markup = renderToStaticMarkup(
			<CaptionProgress
				processedMilliseconds={60_000}
				totalMilliseconds={240_000}
			/>
		)
		expect(markup).toContain('data-caption-progress="determinate"')
		expect(markup).toContain('aria-valuetext="25% complete, 1:00 of 4:00"')
		expect(markup).toContain('value="25"')
	})

	test('labels frozen progress as last reported during a health issue', () => {
		const markup = renderToStaticMarkup(
			<CaptionProgress isLive={false} processedMilliseconds={90_000} />
		)
		expect(markup).toContain(
			'aria-label="Last reported transcription progress"'
		)
		expect(markup).toContain('Last reported')
		expect(markup).not.toContain('animate-pulse')
	})
})

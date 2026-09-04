import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { TranscriptionStatus } from '~/captions/api'
import type { CaptionSessionSnapshot } from '~/captions/CaptionSession'
import { TORRENT_SERVER_STATUS_PANEL_ID } from '../TorrentServerStatus'
import {
	CaptionButtons,
	CaptionStatusMetadata,
	CaptionText,
	captionActions,
} from './LiveCaptions'

const STATUS: TranscriptionStatus = {
	attempt: 4,
	createdAt: '2026-09-04T09:00:00.000Z',
	fileId: '7',
	fileLength: 42,
	infoHash: '0123456789abcdef0123456789abcdef01234567',
	path: ['Book', '01.mp3'],
	processedMilliseconds: 90_000,
	queuedAhead: 2,
	queuePosition: 3,
	state: 'queued',
	trigger: 'manual',
	updatedAt: '2026-09-04T10:00:00.000Z',
}

const snapshot = (
	overrides: Partial<CaptionSessionSnapshot> = {}
): CaptionSessionSnapshot => ({
	cached: false,
	phase: 'queued',
	status: STATUS,
	...overrides,
})

const resolveVoid = (): Promise<void> => Promise.resolve()
const doNothing = (): void => undefined

describe('live caption reading stage', () => {
	test('keeps all three caption slots on fixed, left-aligned anchors with shared typography', () => {
		const lines = ['Previous sentence.', 'Current sentence.', 'Next sentence.']
		const markup = renderToStaticMarkup(
			<CaptionText
				index={1}
				session={{ textAt: (index) => lines[index] ?? '' }}
			/>
		)

		expect(markup).toContain('data-caption-layout="fixed-three-row"')
		expect(markup).toContain('grid h-48 w-full grid-rows-3 gap-2 text-left')
		expect(markup.match(/data-caption-slot=/g)).toHaveLength(3)
		expect(markup.match(/h-full min-w-0 w-full/g)).toHaveLength(3)
		expect(markup.match(/break-words text-left/g)).toHaveLength(3)
		expect(markup.match(/font-semibold/g)).toHaveLength(3)
		expect(markup.match(/text-lg/g)).toHaveLength(3)
		expect(markup).not.toContain('items-center')
		expect(markup).not.toContain('truncate')
	})

	test('preserves an empty previous slot at the beginning of a transcript', () => {
		const markup = renderToStaticMarkup(
			<CaptionText index={0} session={{ textAt: () => '' }} />
		)

		expect(markup).toContain(
			'data-caption-slot="previous"></p><p aria-atomic="true"'
		)
	})
})

describe('live caption recovery controls', () => {
	test('checks status without presenting a polling outage as a retryable job failure', () => {
		expect(
			captionActions(
				snapshot({
					connectionIssue: {
						consecutiveFailures: 2,
						detectedAt: '2026-09-04T10:01:00.000Z',
						kind: 'unreachable',
					},
				}),
				true
			)
		).toEqual({
			cancel: true,
			checkStatus: true,
			openSettings: false,
			restart: false,
			retry: false,
			retryLabel: 'Retry transcription',
			showServerDownload: false,
			start: false,
		})
	})

	test('offers an explicit restart only for a stalled active attempt', () => {
		expect(
			captionActions(
				snapshot({
					connectionIssue: {
						consecutiveFailures: 0,
						detectedAt: '2026-09-04T10:20:00.000Z',
						kind: 'stalled',
					},
					phase: 'transcribing',
					status: { ...STATUS, state: 'transcribing' },
				}),
				true
			)
		).toMatchObject({
			cancel: true,
			checkStatus: false,
			restart: true,
			retry: false,
		})
	})

	test('labels a cancelled terminal attempt as restartable', () => {
		expect(
			captionActions(
				snapshot({
					phase: 'cancelled',
					status: { ...STATUS, state: 'cancelled' },
				}),
				true
			)
		).toMatchObject({
			retry: true,
			retryLabel: 'Restart transcription',
		})
	})

	test('disables restart while terminal work still owns local resources', () => {
		expect(
			captionActions(
				snapshot({
					phase: 'cancelling',
					status: {
						...STATUS,
						cleanupPending: true,
						state: 'cancelled',
					},
				}),
				true
			)
		).toEqual({
			cancel: false,
			checkStatus: false,
			openSettings: false,
			restart: false,
			retry: false,
			retryLabel: 'Restart transcription',
			showServerDownload: false,
			start: false,
		})
	})

	test('does not infer retryability when a failed action has no status metadata', () => {
		expect(
			captionActions(
				snapshot({
					phase: 'failed',
					status: null,
				}),
				true
			)
		).toMatchObject({ retry: false, showServerDownload: false })
	})

	test('offers download controls and an explicit availability check for missing server audio', () => {
		const actions = captionActions(
			snapshot({
				actionError: {
					code: 'audio_not_local',
					message: 'The audiobook must finish downloading before transcription',
					retryable: false,
					status: 409,
				},
				phase: 'failed',
				status: null,
			}),
			true
		)
		expect(actions).toMatchObject({
			retry: true,
			retryLabel: 'Check chapter availability',
			showServerDownload: true,
		})

		const markup = renderToStaticMarkup(
			<CaptionButtons
				actions={actions}
				onCancel={resolveVoid}
				onCheckStatus={resolveVoid}
				onRestart={resolveVoid}
				onRetry={resolveVoid}
				onShowServerDownload={doNothing}
			/>
		)
		expect(markup).toContain('Open server download controls')
		expect(markup).toContain('Check chapter availability')
		expect(markup).toContain(
			`aria-controls="${TORRENT_SERVER_STATUS_PANEL_ID}"`
		)
		expect(markup).not.toContain('Retry transcription')
	})

	test('routes a persisted audio-not-local job to the same prerequisite action', () => {
		expect(
			captionActions(
				snapshot({
					phase: 'failed',
					status: {
						...STATUS,
						error: {
							ambiguous: false,
							code: 'audio_not_local',
							message:
								'The audiobook must finish downloading before transcription',
							retryable: true,
						},
						state: 'failed',
					},
				}),
				true
			)
		).toMatchObject({
			retry: true,
			retryLabel: 'Check chapter availability',
			showServerDownload: true,
		})
	})

	test('shows attempt, queue position, chapters ahead, and timestamp diagnostics', () => {
		const markup = renderToStaticMarkup(
			<CaptionStatusMetadata status={STATUS} />
		)
		expect(markup).toContain('Attempt 4')
		expect(markup).toContain('Queue position 3')
		expect(markup).toContain('2 chapters ahead')
		expect(markup).toContain('<time dateTime="2026-09-04T10:00:00.000Z"')
	})

	test('labels physical cleanup ownership in diagnostics', () => {
		const markup = renderToStaticMarkup(
			<CaptionStatusMetadata status={{ ...STATUS, cleanupPending: true }} />
		)
		expect(markup).toContain('Releasing local resources')
	})

	test('labels a queue paused behind physical cleanup', () => {
		const markup = renderToStaticMarkup(
			<CaptionStatusMetadata
				status={{ ...STATUS, queueBlockedByCleanup: true }}
			/>
		)
		expect(markup).toContain('Queue paused for cleanup')
	})
})

import { observer } from 'mobx-react-lite'
import {
	useCallback,
	useEffect,
	useRef,
	useState,
	useSyncExternalStore,
} from 'react'
import { Link } from 'wouter'
import type { TranscriptionStatus } from '~/captions/api'
import {
	CaptionSession,
	type CaptionSessionPhase,
	type CaptionSessionSnapshot,
} from '~/captions/CaptionSession'
import { Button } from '~/components/ui/button'
import { cn } from '~/lib/utils'
import { storage } from '~/storage'
import {
	revealTorrentServerStatus,
	TORRENT_SERVER_STATUS_PANEL_ID,
} from '../TorrentServerStatus'
import { CaptionProgress, resolveCaptionProgressTotal } from './CaptionProgress'

const CAPTION_CLOCK_INTERVAL_MS = 100

interface PlayerStore {
	getDuration: () => number
	getProgress: () => number
	loaded: boolean
}

interface CurrentFile {
	id?: string
	length?: number
	path: string[]
}

interface BookStore {
	currentFile: CurrentFile
	ih: string
	playerStore: PlayerStore
	serverAccessAllowed: boolean
}

interface LiveCaptionsProps {
	store: BookStore
}

const phaseLabel = (phase: CaptionSessionPhase): string => {
	switch (phase) {
		case 'cancelled':
			return 'Transcription was cancelled.'
		case 'cancelling':
			return 'Cancelling transcription…'
		case 'cleaning':
			return 'Releasing local transcription resources…'
		case 'failed':
			return 'Captions could not be prepared.'
		case 'idle':
			return 'Choose an audio chapter to show live captions.'
		case 'loading':
			return 'Loading captions…'
		case 'preparing':
			return 'Preparing local audio for transcription…'
		case 'queued':
			return 'Waiting to transcribe this chapter…'
		case 'transcribing':
			return 'Transcribing this chapter…'
		case 'unavailable':
			return 'Captions are not available for this chapter.'
		case 'ready':
			return ''
		default:
			return ''
	}
}

const isRunningStatus = (
	status: TranscriptionStatus | null
): status is TranscriptionStatus =>
	status?.state === 'queued' ||
	status?.state === 'preparing' ||
	status?.state === 'transcribing'

const formatStatusTimestamp = (timestamp: string): string => {
	const date = new Date(timestamp)
	if (!Number.isFinite(date.getTime())) {
		return 'unknown time'
	}
	return new Intl.DateTimeFormat(undefined, {
		dateStyle: 'medium',
		timeStyle: 'short',
	}).format(date)
}

const queuedAheadLabel = (queuedAhead: number): string => {
	if (queuedAhead === 0) {
		return 'Next to start'
	}
	return `${queuedAhead} ${queuedAhead === 1 ? 'chapter' : 'chapters'} ahead`
}

const StatusTime = ({
	label,
	timestamp,
}: {
	label: string
	timestamp: string
}) => (
	<span>
		{label}{' '}
		<time dateTime={timestamp} title={new Date(timestamp).toLocaleString()}>
			{formatStatusTimestamp(timestamp)}
		</time>
	</span>
)

export const CaptionStatusMetadata = ({
	status,
}: {
	status: TranscriptionStatus
}) => (
	<div
		className='flex flex-wrap justify-center gap-x-2 gap-y-0.5 text-muted-foreground/80 text-xs tabular-nums'
		data-caption-diagnostics='true'
	>
		<span>Attempt {status.attempt}</span>
		{status.cleanupPending ? <span>Releasing local resources</span> : null}
		{status.queueBlockedByCleanup ? (
			<span>Queue paused for cleanup</span>
		) : null}
		{status.state === 'queued' && status.queuePosition ? (
			<span>Queue position {status.queuePosition}</span>
		) : null}
		{status.state === 'queued' && status.queuedAhead !== undefined ? (
			<span>{queuedAheadLabel(status.queuedAhead)}</span>
		) : null}
		{status.startedAt ? (
			<StatusTime label='Started' timestamp={status.startedAt} />
		) : null}
		<StatusTime label='Updated' timestamp={status.updatedAt} />
	</div>
)

const CAPTION_SLOT_CLASS =
	'line-clamp-2 h-full min-w-0 w-full self-start overflow-hidden break-words text-left font-semibold text-lg leading-snug tracking-tight sm:text-xl'

const CaptionSlot = ({
	active = false,
	children,
	position,
}: {
	active?: boolean
	children: string
	position: 'current' | 'next' | 'previous'
}) => (
	<p
		aria-atomic={active ? 'true' : undefined}
		aria-hidden={active ? undefined : 'true'}
		aria-live={active ? 'polite' : undefined}
		className={cn(
			CAPTION_SLOT_CLASS,
			active ? 'text-foreground' : 'text-muted-foreground/55'
		)}
		data-caption-slot={position}
	>
		{children}
	</p>
)

export const CaptionText = ({
	session,
	index,
}: {
	index: number
	session: Pick<CaptionSession, 'textAt'>
}) => {
	const hasActiveCaption = index >= 0
	const currentText = hasActiveCaption ? session.textAt(index) : ''
	const previousText = hasActiveCaption ? session.textAt(index - 1) : ''
	const nextText = hasActiveCaption ? session.textAt(index + 1) : ''
	return (
		<div
			className='grid h-48 w-full grid-rows-3 gap-2 text-left'
			data-caption-layout='fixed-three-row'
		>
			<CaptionSlot position='previous'>{previousText}</CaptionSlot>
			<CaptionSlot active position='current'>
				{currentText || 'Captions will appear with the spoken audio.'}
			</CaptionSlot>
			<CaptionSlot position='next'>{nextText}</CaptionSlot>
		</div>
	)
}

export interface CaptionActions {
	cancel: boolean
	checkStatus: boolean
	openSettings: boolean
	restart: boolean
	retry: boolean
	retryLabel:
		| 'Check chapter availability'
		| 'Restart transcription'
		| 'Retry transcription'
	showServerDownload: boolean
	start: boolean
}

const needsServerAudio = (snapshot: CaptionSessionSnapshot): boolean =>
	snapshot.actionError?.code === 'audio_not_local' ||
	snapshot.status?.error?.code === 'audio_not_local'

const serverAudioPrerequisiteMessage = (
	snapshot: CaptionSessionSnapshot
): string =>
	snapshot.phase === 'ready'
		? `${snapshot.cached ? 'Saved captions remain available.' : 'Captions remain available for this session but are not saved offline.'} A refreshed transcript can start once the selected chapter finishes downloading on the TPlayer server.`
		: 'The selected chapter is not fully available on the TPlayer server yet. Open the server download controls; transcription can start once this chapter finishes downloading there.'

const captionRetryLabel = (
	snapshot: CaptionSessionSnapshot,
	serverAudioRequired: boolean
): CaptionActions['retryLabel'] => {
	if (serverAudioRequired) {
		return 'Check chapter availability'
	}
	if (
		snapshot.phase === 'cancelled' ||
		snapshot.status?.state === 'cancelled'
	) {
		return 'Restart transcription'
	}
	return 'Retry transcription'
}

export const captionActions = (
	snapshot: CaptionSessionSnapshot,
	serverAccessAllowed: boolean
): CaptionActions => {
	const runningStatus = isRunningStatus(snapshot.status)
	const serverAudioRequired = needsServerAudio(snapshot)
	const failedStatusRetryable =
		snapshot.status?.state === 'failed' &&
		snapshot.status.error?.retryable === true
	const failedActionRetryable =
		snapshot.phase === 'failed' && snapshot.actionError?.retryable === true
	const unavailable = snapshot.phase === 'unavailable'
	const stalled = snapshot.connectionIssue?.kind === 'stalled'
	const unreachable = snapshot.connectionIssue?.kind === 'unreachable'
	const canCheckServerAudio =
		serverAudioRequired && serverAccessAllowed && !unreachable
	if (snapshot.status?.cleanupPending) {
		return {
			cancel: false,
			checkStatus: unreachable,
			openSettings: false,
			restart: false,
			retry: false,
			retryLabel:
				snapshot.status.state === 'cancelled'
					? 'Restart transcription'
					: 'Retry transcription',
			showServerDownload: false,
			start: false,
		}
	}
	const retryableTerminalState =
		snapshot.phase === 'cancelled' ||
		failedStatusRetryable ||
		failedActionRetryable ||
		(snapshot.phase === 'ready' &&
			(snapshot.status?.state === 'cancelled' || failedStatusRetryable))
	return {
		cancel:
			snapshot.phase === 'queued' ||
			snapshot.phase === 'preparing' ||
			snapshot.phase === 'transcribing' ||
			(snapshot.phase === 'ready' && runningStatus),
		checkStatus: unreachable,
		openSettings: unavailable && !serverAccessAllowed && !unreachable,
		restart: stalled,
		retry:
			canCheckServerAudio ||
			(retryableTerminalState &&
				!serverAudioRequired &&
				!(stalled || unreachable)),
		retryLabel: captionRetryLabel(snapshot, serverAudioRequired),
		showServerDownload: serverAudioRequired && !unreachable,
		start: unavailable && serverAccessAllowed && !unreachable,
	}
}

export const CaptionButtons = ({
	actions,
	onCancel,
	onCheckStatus,
	onRestart,
	onRetry,
	onShowServerDownload,
}: {
	actions: CaptionActions
	onCancel: () => Promise<void>
	onCheckStatus: () => Promise<void>
	onRestart: () => Promise<void>
	onRetry: () => Promise<void>
	onShowServerDownload: () => void
}) => (
	<>
		{actions.checkStatus ? (
			<Button
				onClick={onCheckStatus}
				size='sm'
				type='button'
				variant='secondary'
			>
				Check status
			</Button>
		) : null}
		{actions.restart ? (
			<Button onClick={onRestart} size='sm' type='button' variant='secondary'>
				Restart transcription
			</Button>
		) : null}
		{actions.cancel ? (
			<Button onClick={onCancel} size='sm' type='button' variant='ghost'>
				Cancel transcription
			</Button>
		) : null}
		{actions.retry ? (
			<Button onClick={onRetry} size='sm' type='button' variant='secondary'>
				{actions.retryLabel}
			</Button>
		) : null}
		{actions.showServerDownload ? (
			<Button
				aria-controls={TORRENT_SERVER_STATUS_PANEL_ID}
				onClick={onShowServerDownload}
				size='sm'
				type='button'
				variant='secondary'
			>
				Open server download controls
			</Button>
		) : null}
		{actions.start ? (
			<Button onClick={onRetry} size='sm' type='button' variant='secondary'>
				Transcribe this chapter
			</Button>
		) : null}
		{actions.openSettings ? (
			<Button asChild size='sm' variant='ghost'>
				<Link href='/settings'>Open transcription settings</Link>
			</Button>
		) : null}
	</>
)

const captionIssueCopy = (
	snapshot: CaptionSessionSnapshot
): { detail: string; title: string } | null => {
	if (snapshot.connectionIssue?.kind === 'stalled') {
		return {
			detail:
				'The server is reachable, but this attempt has not reported progress recently. Restart it or cancel it.',
			title: 'Transcription appears stalled.',
		}
	}
	if (snapshot.connectionIssue?.kind === 'unreachable') {
		return {
			detail:
				snapshot.message ??
				'TPlayer will keep checking automatically. Last reported progress is shown.',
			title: 'Transcription status is temporarily unavailable.',
		}
	}
	return null
}

const CaptionIssue = ({ detail, title }: { detail: string; title: string }) => (
	<div className='space-y-0.5 text-center'>
		<p className='font-medium text-foreground text-sm' role='status'>
			{title}
		</p>
		<p className='text-muted-foreground text-xs'>{detail}</p>
	</div>
)

const CaptionMessage = ({
	issueCopy,
	message,
}: {
	issueCopy: { detail: string; title: string } | null
	message?: string
}) => {
	if (issueCopy) {
		return <CaptionIssue detail={issueCopy.detail} title={issueCopy.title} />
	}
	if (!message) {
		return null
	}
	return <p className='text-center text-muted-foreground text-xs'>{message}</p>
}

const CaptionContent = ({
	actions,
	captionIndex,
	label,
	onCancel,
	onCheckStatus,
	onRestart,
	onRetry,
	onShowServerDownload,
	progressTotalMilliseconds,
	session,
	snapshot,
}: {
	actions: CaptionActions
	captionIndex: number
	label: string
	onCancel: () => Promise<void>
	onCheckStatus: () => Promise<void>
	onRestart: () => Promise<void>
	onRetry: () => Promise<void>
	onShowServerDownload: () => void
	progressTotalMilliseconds?: number
	session: CaptionSession
	snapshot: CaptionSessionSnapshot
}) => {
	const activeTranscription = isRunningStatus(snapshot.status)
	const issueCopy = captionIssueCopy(snapshot)
	const serverAudioRequired = needsServerAudio(snapshot)
	const message = serverAudioRequired
		? serverAudioPrerequisiteMessage(snapshot)
		: snapshot.message
	const showDiagnostics =
		!serverAudioRequired &&
		snapshot.status !== null &&
		snapshot.status.state !== 'completed'
	const progress = activeTranscription ? (
		<CaptionProgress
			isLive={!snapshot.connectionIssue}
			processedMilliseconds={snapshot.status?.processedMilliseconds ?? 0}
			queueBlockedByCleanup={snapshot.status?.queueBlockedByCleanup}
			state={
				snapshot.status?.state === 'preparing' ||
				snapshot.status?.state === 'queued' ||
				snapshot.status?.state === 'transcribing'
					? snapshot.status.state
					: undefined
			}
			totalMilliseconds={progressTotalMilliseconds}
		/>
	) : null
	if (snapshot.phase === 'ready') {
		return (
			<div className='w-full'>
				<CaptionText index={captionIndex} session={session} />
				<CaptionMessage issueCopy={issueCopy} message={message} />
				{progress ? (
					<div className='mx-auto mt-2 max-w-xl'>{progress}</div>
				) : null}
				{showDiagnostics && snapshot.status ? (
					<div className='mt-1.5'>
						<CaptionStatusMetadata status={snapshot.status} />
					</div>
				) : null}
				<div className='mt-1 flex justify-center gap-2'>
					<CaptionButtons
						actions={actions}
						onCancel={onCancel}
						onCheckStatus={onCheckStatus}
						onRestart={onRestart}
						onRetry={onRetry}
						onShowServerDownload={onShowServerDownload}
					/>
				</div>
			</div>
		)
	}
	return (
		<div className='flex w-full max-w-xl flex-col items-center gap-2 text-center'>
			{issueCopy ? (
				<CaptionIssue detail={issueCopy.detail} title={issueCopy.title} />
			) : (
				<p className='text-muted-foreground text-sm' role='status'>
					{message ?? label}
				</p>
			)}
			{progress}
			{showDiagnostics && snapshot.status ? (
				<CaptionStatusMetadata status={snapshot.status} />
			) : null}
			<CaptionButtons
				actions={actions}
				onCancel={onCancel}
				onCheckStatus={onCheckStatus}
				onRestart={onRestart}
				onRetry={onRetry}
				onShowServerDownload={onShowServerDownload}
			/>
		</div>
	)
}

export const LiveCaptions = observer(({ store }: LiveCaptionsProps) => {
	const { currentFile, ih, playerStore, serverAccessAllowed } = store
	const [session] = useState(() => new CaptionSession({ repository: storage }))
	const snapshot = useSyncExternalStore(
		session.subscribe,
		session.getSnapshot,
		session.getSnapshot
	)
	const [captionIndex, setCaptionIndex] = useState(-1)
	const captionIndexRef = useRef(-1)
	const currentPath = currentFile.path.join('/')
	const fileId = currentFile.id ?? ''
	const fileLength = currentFile.length ?? 0

	useEffect(() => {
		const target =
			ih && fileId && currentPath
				? {
						fileId,
						fileLength,
						infoHash: ih,
						path: [...currentFile.path],
					}
				: null
		session.activate(target, serverAccessAllowed).catch(() => undefined)
	}, [
		currentFile.path,
		currentPath,
		fileId,
		fileLength,
		ih,
		serverAccessAllowed,
		session,
	])

	useEffect(
		() => () => {
			session.dispose()
		},
		[session]
	)

	useEffect(() => {
		if (snapshot.phase !== 'ready') {
			captionIndexRef.current = -1
			setCaptionIndex(-1)
			return
		}
		const updateCaption = (): void => {
			const nextIndex = session.seek(playerStore.getProgress() * 1000)
			if (nextIndex === captionIndexRef.current) {
				return
			}
			captionIndexRef.current = nextIndex
			setCaptionIndex(nextIndex)
		}
		updateCaption()
		const interval = setInterval(updateCaption, CAPTION_CLOCK_INTERVAL_MS)
		return () => clearInterval(interval)
	}, [playerStore, session, snapshot.phase])

	const retry = useCallback(async (): Promise<void> => {
		await session.retry()
	}, [session])

	const cancel = useCallback(async (): Promise<void> => {
		await session.cancel()
	}, [session])

	const checkStatus = useCallback(async (): Promise<void> => {
		await session.checkStatus()
	}, [session])

	const restart = useCallback(async (): Promise<void> => {
		await session.restart()
	}, [session])

	const showServerDownload = useCallback((): void => {
		revealTorrentServerStatus()
	}, [])

	const actions = captionActions(snapshot, serverAccessAllowed)
	const label = phaseLabel(snapshot.phase)
	const playerDurationSeconds = playerStore.loaded
		? playerStore.getDuration()
		: undefined
	const progressTotalMilliseconds = resolveCaptionProgressTotal(
		snapshot.status?.state,
		snapshot.status?.totalMilliseconds,
		playerStore.loaded,
		playerDurationSeconds
	)
	const activeTranscription = isRunningStatus(snapshot.status)
	const cleanupPending = snapshot.status?.cleanupPending === true
	const healthyTranscription =
		activeTranscription && snapshot.connectionIssue === undefined

	return (
		<section
			aria-busy={
				cleanupPending || (healthyTranscription && snapshot.phase !== 'ready')
			}
			aria-label='Live captions'
			className='mx-4 flex min-h-28 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-border/70 bg-muted/45 px-5 py-2 shadow-inner'
			data-caption-cleanup={cleanupPending ? 'pending' : 'settled'}
			data-caption-health={snapshot.connectionIssue?.kind ?? 'healthy'}
			data-caption-state={snapshot.phase}
		>
			<CaptionContent
				actions={actions}
				captionIndex={captionIndex}
				label={label}
				onCancel={cancel}
				onCheckStatus={checkStatus}
				onRestart={restart}
				onRetry={retry}
				onShowServerDownload={showServerDownload}
				progressTotalMilliseconds={progressTotalMilliseconds}
				session={session}
				snapshot={snapshot}
			/>
		</section>
	)
})

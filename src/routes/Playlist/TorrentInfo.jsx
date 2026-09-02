import { X } from 'lucide-react'
import { observer } from 'mobx-react-lite'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ContentUseDialog } from '~/components/ContentUseDialog'
import { CoverImage } from '~/components/CoverImage'
import { Button } from '~/components/ui/button'
import { Card } from '~/components/ui/card'
import { cn } from '~/lib/utils'
import {
	hasCurrentContentPolicyAcknowledgement,
	loadSearchPreferences,
	rememberCurrentContentPolicyAcknowledgement,
} from '~/search/preferences'
import { consumeTorrentServerAccessGrant } from '~/search/torrentAccessGrant'
import { comparePath, isAudioFile, naturalCompare } from '~/utils'
import { ActionDialog } from './ActionDialog'
import { ApiError, getTorrentStatus, registerTorrent } from './api'
import { COMBINED_FILES_PREFIX } from './store'
import { TorrentServerStatus } from './TorrentServerStatus'
import { formatBytes } from './utils'

const SERVER_STATUS_POLL_INTERVAL_MS = 1500
const NETWORK_ERROR_PATTERN =
	/failed to fetch|networkerror|network request failed/i

const waitForNextServerStatusPoll = (signal) =>
	new Promise((resolve) => {
		if (signal.aborted) {
			resolve(false)
			return
		}
		const handleAbort = () => {
			clearTimeout(timeoutId)
			resolve(false)
		}
		const timeoutId = setTimeout(() => {
			signal.removeEventListener('abort', handleAbort)
			resolve(true)
		}, SERVER_STATUS_POLL_INTERVAL_MS)
		signal.addEventListener('abort', handleAbort, { once: true })
	})

const errorMessage = (error, fallback) => {
	const message = error instanceof Error ? error.message : ''
	if (error instanceof TypeError || NETWORK_ERROR_PATTERN.test(message)) {
		return 'The TPlayer server could not be reached. If this site requires sign-in, sign in again, then check again.'
	}
	return message || fallback
}

const isTerminalServerStatus = (status) =>
	status.state === 'completed' ||
	status.state === 'failed' ||
	status.state === 'idle'

const pollTorrentServerOnce = async ({
	infoHash,
	metadataAccessAllowed,
	loadMetadata,
	metadataAvailable,
	onConnectionError,
	onMetadataError,
	onNotFound,
	onStatus,
	signal,
}) => {
	let status
	try {
		status = await getTorrentStatus(infoHash, signal)
	} catch (error) {
		if (signal.aborted) {
			return { done: true, metadataAvailable }
		}
		onConnectionError(
			errorMessage(error, 'The server status could not be reached.')
		)
		if (
			error instanceof ApiError &&
			error.code === 'torrent_status_unavailable'
		) {
			return { done: true, metadataAvailable }
		}
		const shouldContinue = await waitForNextServerStatusPoll(signal)
		return { done: !shouldContinue, metadataAvailable }
	}

	if (signal.aborted) {
		return { done: true, metadataAvailable }
	}
	if (!status) {
		await onNotFound(metadataAvailable)
		return { done: true, metadataAvailable }
	}

	onStatus(status)
	let nextMetadataAvailable = metadataAvailable
	if (metadataAccessAllowed && status.metadataReady && !nextMetadataAvailable) {
		nextMetadataAvailable = await loadMetadata()
		if (signal.aborted) {
			return { done: true, metadataAvailable: nextMetadataAvailable }
		}
		if (!nextMetadataAvailable) {
			onMetadataError()
		}
	}
	if (isTerminalServerStatus(status)) {
		return { done: true, metadataAvailable: nextMetadataAvailable }
	}
	const shouldContinue = await waitForNextServerStatusPoll(signal)
	return {
		done: !shouldContinue,
		metadataAvailable: nextMetadataAvailable,
	}
}

const pollTorrentServer = async ({
	loadCachedMetadata,
	signal,
	...options
}) => {
	await loadCachedMetadata()
	let metadataAvailable = false
	if (signal.aborted) {
		return
	}
	while (!signal.aborted) {
		const { done, metadataAvailable: nextMetadataAvailable } =
			// biome-ignore lint/performance/noAwaitInLoops: Each status poll is sequential, delayed, and abortable.
			await pollTorrentServerOnce({
				...options,
				metadataAvailable,
				signal,
			})
		metadataAvailable = nextMetadataAvailable
		if (done) {
			return
		}
	}
}

const offlinePercent = (file) => {
	if (file.length <= 0) {
		return file.cached ? 100 : 0
	}
	return Math.min(
		100,
		Math.floor(((file.offlineDownloadedBytes ?? 0) / file.length) * 100)
	)
}

const playingFileStatus = (file, sourceKind, savedPercent) => {
	if (sourceKind === 'offline') {
		return { label: 'playing offline', state: 'playing-offline' }
	}
	if (file.offlineState === 'saving') {
		return {
			label: `streaming · saving offline ${savedPercent}%`,
			state: 'streaming-saving',
		}
	}
	if (file.cached) {
		return {
			label: 'streaming · available offline',
			state: 'streaming-cached',
		}
	}
	if (file.offlineState === 'unavailable') {
		return {
			label: 'streaming · offline storage full',
			state: 'streaming-unavailable',
		}
	}
	if (file.offlineState === 'failed') {
		return {
			label: 'streaming · offline save failed',
			state: 'streaming-save-failed',
		}
	}
	return { label: 'streaming', state: 'streaming' }
}

const savedFileStatus = (file, savedPercent) => {
	if (file.offlineState === 'saving') {
		return {
			label: `saving offline ${savedPercent}%`,
			state: 'saving',
		}
	}
	if (file.cached) {
		if (file.isCombined) {
			const [start, end] = file.originalIndexes
			return {
				label: `available offline (${end - start + 1} files)`,
				state: 'offline',
			}
		}
		return { label: 'available offline', state: 'offline' }
	}
	if (file.offlineState === 'paused') {
		return {
			label: `offline save paused ${savedPercent}%`,
			state: 'offline-paused',
		}
	}
	if (file.offlineState === 'unavailable') {
		return { label: 'offline storage full', state: 'offline-unavailable' }
	}
	if (file.offlineState === 'failed') {
		return { label: 'offline save failed', state: 'offline-save-failed' }
	}
	return null
}

const getFileStatus = ({ file, isCurrent, playerStore, sourceKind }) => {
	const savedPercent = offlinePercent(file)
	if (isCurrent && playerStore.playing) {
		return playingFileStatus(file, sourceKind, savedPercent)
	}
	if (isCurrent && playerStore.loading) {
		if (sourceKind === 'server' && file.offlineState === 'saving') {
			return {
				label: `loading audio · saving offline ${savedPercent}%`,
				state: 'loading-saving',
			}
		}
		return { label: 'loading audio', state: 'loading' }
	}
	if (isCurrent && playerStore.error) {
		return { label: 'playback failed', state: 'error' }
	}
	const savedStatus = savedFileStatus(file, savedPercent)
	if (savedStatus) {
		return savedStatus
	}
	if (isCurrent && playerStore.loaded) {
		return { label: 'ready to stream', state: 'ready' }
	}
	return { label: formatBytes(file.length), state: 'idle' }
}

const stripCombinedPrefix = (path) => {
	if (path[0] === COMBINED_FILES_PREFIX) {
		return path.slice(1)
	}
	return path
}

const loadAndSortFiles = async (store, ih) => {
	if (!ih) {
		return []
	}
	const files = await store.getAllTorrentFiles(ih)
	files.sort((a, b) => {
		const aPath = stripCombinedPrefix(a.path).join('/')
		const bPath = stripCombinedPrefix(b.path).join('/')
		return naturalCompare(aPath, bPath)
	})
	return files
}

const TorrentFileRow = observer(
	({
		currentFile,
		file,
		onDelete,
		onSelect,
		playerStore,
		serverAccessAllowed,
		sourceKind,
	}) => {
		const { path } = file
		const displayPath = stripCombinedPrefix(path).join('/')
		const isCurrent = comparePath(path, currentFile.path)
		const currentStyle = isCurrent ? 'bg-accent/80' : ''
		const playable = isAudioFile(file) && (serverAccessAllowed || file.cached)
		const status = getFileStatus({
			file,
			isCurrent,
			playerStore,
			sourceKind,
		})

		const handleSelect = () => {
			onSelect(file)
		}

		const handleDelete = async (event) => {
			event.stopPropagation()
			await onDelete(file)
		}

		return (
			<div
				className={`flex items-center justify-between border-border/70 border-b transition-colors last:border-b-0 hover:bg-muted/70 ${currentStyle}`}
			>
				<button
					aria-busy={
						isCurrent && playerStore.loading && !playerStore.playing
							? 'true'
							: undefined
					}
					aria-current={isCurrent ? 'true' : undefined}
					className='flex min-w-0 grow cursor-pointer items-center justify-between gap-3 border-0 bg-transparent px-3 py-2.5 text-left disabled:cursor-default disabled:opacity-60'
					data-offline-progress={offlinePercent(file)}
					data-playback-source={isCurrent ? sourceKind : undefined}
					data-playback-state={status.state}
					disabled={!playable}
					onClick={handleSelect}
					type='button'
				>
					<span className='flex-1 truncate'>{displayPath}</span>
					<span
						aria-live={isCurrent ? 'polite' : undefined}
						className='shrink-0 text-muted-foreground text-xs'
					>
						{status.label}
					</span>
				</button>
				{file.cached ? (
					<Button
						className='mr-2 text-destructive hover:bg-destructive/10 hover:text-destructive'
						onClick={handleDelete}
						size='icon'
						title='Delete'
						type='button'
						variant='ghost'
					>
						<X className='h-4 w-4' />
					</Button>
				) : null}
			</div>
		)
	}
)

export const TorrentInfo = observer(({ store, showCover }) => {
	const {
		currentFile,
		currentSourceKind,
		filesVersion,
		ih,
		setCurrentFile,
		setServerAccessAllowed,
		serverAccessAllowed,
		setTorrentInfo,
		playerStore,
		torrentInfo,
	} = store
	const [allFiles, setAllFiles] = useState([])
	const [authorizationOpen, setAuthorizationOpen] = useState(false)
	const [pollRevision, setPollRevision] = useState(0)
	const [serverError, setServerError] = useState(null)
	const [serverPhase, setServerPhase] = useState('checking')
	const [serverStatus, setServerStatus] = useState(null)
	const [initialServerAccess] = useState(() => {
		const grantedByNavigation = consumeTorrentServerAccessGrant(ih)
		return {
			allowed:
				grantedByNavigation ||
				hasCurrentContentPolicyAcknowledgement(loadSearchPreferences()),
			registrationAccepted: grantedByNavigation,
		}
	})
	const acceptedRegistrationInfoHashRef = useRef(
		initialServerAccess.registrationAccepted ? ih : null
	)
	const authorizedInfoHashRef = useRef(initialServerAccess.allowed ? ih : null)
	const promptedInfoHashRef = useRef(null)
	const registrationRequestRef = useRef(0)
	const statusControllerRef = useRef(null)

	const startServerRegistration = useCallback(async () => {
		const requestId = registrationRequestRef.current + 1
		registrationRequestRef.current = requestId
		statusControllerRef.current?.abort()
		setServerError(null)
		setServerPhase('registering')
		setServerStatus(null)
		try {
			await registerTorrent(ih)
			if (requestId !== registrationRequestRef.current) {
				return
			}
			acceptedRegistrationInfoHashRef.current = ih
			setPollRevision((revision) => revision + 1)
		} catch (error) {
			if (requestId !== registrationRequestRef.current) {
				return
			}
			setServerError(
				errorMessage(error, 'The server could not add this torrent.')
			)
			setServerPhase('registration-error')
		}
	}, [ih])

	// biome-ignore lint/correctness/useExhaustiveDependencies: pollRevision intentionally restarts the abortable status workflow after a retry or registration.
	useEffect(() => {
		const controller = new AbortController()
		const metadataAccessAllowed = authorizedInfoHashRef.current === ih
		statusControllerRef.current = controller
		setAllFiles([])
		setAuthorizationOpen(false)
		setServerError(null)
		setServerPhase('checking')
		setServerStatus(null)
		setServerAccessAllowed(metadataAccessAllowed)

		pollTorrentServer({
			infoHash: ih,
			loadCachedMetadata: () =>
				setTorrentInfo(ih, { cacheOnly: true, resumePlayback: false }),
			loadMetadata: () => setTorrentInfo(ih),
			metadataAccessAllowed,
			onConnectionError: (message) => {
				setServerError(message)
				setServerPhase('connection-error')
			},
			onMetadataError: () => {
				setServerError(
					'The book details are ready on the server, but this page could not load them.'
				)
				setServerPhase('metadata-error')
			},
			onNotFound: async () => {
				setServerStatus(null)
				if (acceptedRegistrationInfoHashRef.current === ih) {
					setServerError(
						'The server accepted this torrent but could not report the background job afterward. Update or restart the server, then check again.'
					)
					setServerPhase('connection-error')
					return
				}
				setServerError(null)
				setServerPhase('not-found')
				if (metadataAccessAllowed) {
					await startServerRegistration()
					return
				}
				if (promptedInfoHashRef.current !== ih) {
					promptedInfoHashRef.current = ih
					setAuthorizationOpen(true)
				}
			},
			onStatus: (status) => {
				setServerError(null)
				setServerPhase('registered')
				setServerStatus(status)
				if (!metadataAccessAllowed && promptedInfoHashRef.current !== ih) {
					promptedInfoHashRef.current = ih
					setAuthorizationOpen(true)
				}
			},
			signal: controller.signal,
		}).catch((error) => {
			if (!controller.signal.aborted) {
				setServerError(
					errorMessage(error, 'Unable to prepare this torrent page.')
				)
				setServerPhase('connection-error')
			}
		})
		return () => {
			controller.abort()
			if (statusControllerRef.current === controller) {
				statusControllerRef.current = null
			}
			registrationRequestRef.current += 1
		}
	}, [
		ih,
		pollRevision,
		setServerAccessAllowed,
		setTorrentInfo,
		startServerRegistration,
	])

	const closeAuthorization = useCallback(() => {
		setAuthorizationOpen(false)
	}, [])

	const confirmFirstUse = useCallback(async () => {
		const wasAlreadyAuthorized = authorizedInfoHashRef.current === ih
		rememberCurrentContentPolicyAcknowledgement()
		authorizedInfoHashRef.current = ih
		setServerAccessAllowed(true)
		setAuthorizationOpen(false)
		setServerError(null)
		const isRegistered = serverPhase === 'registered' && serverStatus
		if (isRegistered && !wasAlreadyAuthorized) {
			acceptedRegistrationInfoHashRef.current = ih
			setPollRevision((revision) => revision + 1)
			return
		}
		await startServerRegistration()
	}, [
		ih,
		serverPhase,
		serverStatus,
		setServerAccessAllowed,
		startServerRegistration,
	])

	const handleServerAction = useCallback(async () => {
		const acknowledgementIsCurrent =
			authorizedInfoHashRef.current === ih ||
			hasCurrentContentPolicyAcknowledgement(loadSearchPreferences())
		if (!acknowledgementIsCurrent) {
			setAuthorizationOpen(true)
			return
		}

		authorizedInfoHashRef.current = ih
		setServerAccessAllowed(true)
		if (serverPhase === 'registered' && !serverAccessAllowed) {
			acceptedRegistrationInfoHashRef.current = ih
			setPollRevision((revision) => revision + 1)
			return
		}
		await startServerRegistration()
	}, [
		ih,
		serverAccessAllowed,
		serverPhase,
		setServerAccessAllowed,
		startServerRegistration,
	])

	const retryServerStatus = useCallback(() => {
		setPollRevision((revision) => revision + 1)
	}, [])

	const updateFiles = useCallback(async () => {
		const requestedVersion = filesVersion
		const files = await loadAndSortFiles(store, ih)
		if (requestedVersion === store.filesVersion && ih === store.ih) {
			setAllFiles(files)
		}
	}, [filesVersion, ih, store])

	useEffect(() => {
		if (!(torrentInfo.name || torrentInfo.files.length)) {
			return
		}
		updateFiles().catch(store.handlePlaybackError)
	}, [store.handlePlaybackError, torrentInfo, updateFiles])

	const handleDelete = useCallback(
		async (file) => {
			const success = await store.removeFile(ih, file)
			if (success) {
				await updateFiles()
			}
		},
		[ih, store, updateFiles]
	)

	const handleClick = useCallback(
		(file) => {
			setCurrentFile(file).catch(store.handlePlaybackError)
		},
		[setCurrentFile, store.handlePlaybackError]
	)
	const hasTorrentInfo = Boolean(torrentInfo.name || torrentInfo.files.length)
	const displayName = torrentInfo.name || serverStatus?.name || 'Torrent'

	return (
		<div className='flex h-full flex-col'>
			<div className='flex items-center gap-4 px-4 py-4'>
				{showCover && hasTorrentInfo ? (
					<CoverImage
						allowServer={serverAccessAllowed}
						className='h-20 w-20 shadow-sm'
						files={allFiles}
						ih={ih}
						loadingLabel='Loading cover...'
						name={torrentInfo.name}
						normalizePathParts={stripCombinedPrefix}
						placeholderClassName='text-xs text-muted-foreground'
					/>
				) : null}
				<div className='min-w-0 flex-1'>
					<p className='text-muted-foreground text-xs uppercase tracking-widest'>
						Audiobook
					</p>
					<h1 className='mt-1 truncate font-semibold text-xl tracking-tight'>
						{displayName}
					</h1>
				</div>
			</div>
			<div className='min-h-0 flex-1 touch-pan-y overflow-auto px-2 pb-4'>
				<div className='space-y-2'>
					<TorrentServerStatus
						error={serverError}
						onAction={handleServerAction}
						onRetry={retryServerStatus}
						phase={serverPhase}
						serverAccessAllowed={serverAccessAllowed}
						status={serverStatus}
					/>
					{hasTorrentInfo ? (
						<>
							<Card className='overflow-hidden'>
								{allFiles.map((file) => (
									<TorrentFileRow
										currentFile={currentFile}
										file={file}
										key={file.path.join('/')}
										onDelete={handleDelete}
										onSelect={handleClick}
										playerStore={playerStore}
										serverAccessAllowed={serverAccessAllowed}
										sourceKind={currentSourceKind}
									/>
								))}
							</Card>
							<StorageStatus allFiles={allFiles} store={store} />
							<CleanBookDataButtons allFiles={allFiles} store={store} />
						</>
					) : null}
				</div>
			</div>
			<ContentUseDialog
				action='open-direct'
				isOpen={authorizationOpen}
				onCancel={closeAuthorization}
				onConfirm={confirmFirstUse}
			/>
		</div>
	)
})

const offlineBytes = (files) =>
	files.reduce(
		(total, file) =>
			total +
			Math.min(
				file.length,
				Math.max(
					0,
					file.offlineDownloadedBytes ?? (file.cached ? file.length : 0)
				)
			),
		0
	)

const StorageStatus = observer(({ allFiles, store }) => {
	const localBytes = offlineBytes(allFiles)
	const serverBytes = store.serverCachedBytes
	return (
		<Card
			aria-label='Book storage status'
			className='grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 px-3 py-2 text-muted-foreground text-sm shadow-none'
			role='status'
		>
			<span>Server cache</span>
			<span data-server-cache-bytes={serverBytes ?? ''}>
				{serverBytes === null ? 'Unavailable' : formatBytes(serverBytes)}
			</span>
			<span>Offline on this device</span>
			<span data-offline-bytes={localBytes}>{formatBytes(localBytes)}</span>
		</Card>
	)
})

export const CleanBookDataButtons = observer(
	({ store, allFiles, compact = false }) => {
		const { cleanBookData, ih, removeBook } = store
		const [pendingAction, setPendingAction] = useState(null)
		const cachedPartsLength = offlineBytes(allFiles)
		const hasOfflineWork = allFiles.some(
			(file) => file.offlineState === 'saving' || file.offlineState === 'paused'
		)

		const requestClean = useCallback(() => {
			setPendingAction('clean')
		}, [])

		const requestRemove = useCallback(() => {
			setPendingAction('remove')
		}, [])

		const cancelAction = useCallback(() => {
			setPendingAction(null)
		}, [])

		const confirmAction = useCallback(async () => {
			const action = pendingAction
			setPendingAction(null)
			if (action === 'clean') {
				await cleanBookData(ih)
				return
			}
			if (action === 'remove') {
				const removed = await removeBook(ih)
				if (removed) {
					window.history.pushState(null, '', '/')
				}
			}
		}, [cleanBookData, ih, pendingAction, removeBook])

		return (
			<>
				<Card
					className={cn(
						'flex flex-col overflow-hidden p-1 shadow-none',
						compact && 'border-0'
					)}
				>
					<Button
						className='w-full justify-center text-muted-foreground hover:text-foreground'
						disabled={cachedPartsLength === 0 && !hasOfflineWork}
						onClick={requestClean}
						type='button'
						variant='ghost'
					>
						Clear offline data ({formatBytes(cachedPartsLength)})
					</Button>
					<Button
						className='w-full justify-center text-destructive hover:bg-destructive/10 hover:text-destructive'
						onClick={requestRemove}
						type='button'
						variant='ghost'
					>
						Remove Book from Library
					</Button>
				</Card>
				<ActionDialog
					description={
						pendingAction === 'clean'
							? 'Delete all book files stored offline on this device? The server cache is not affected.'
							: 'Remove this book from the library?'
					}
					isOpen={pendingAction !== null}
					onCancel={cancelAction}
					onConfirm={confirmAction}
					title={
						pendingAction === 'clean' ? 'Clear offline data?' : 'Remove book?'
					}
				/>
			</>
		)
	}
)

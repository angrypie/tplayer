import { X } from 'lucide-react'
import { observer } from 'mobx-react-lite'
import { useCallback, useEffect, useState } from 'react'
import { CoverImage } from '~/components/CoverImage'
import { Nav } from '~/components/layout/Nav'
import { Button } from '~/components/ui/button'
import { comparePath, isAudioFile, naturalCompare } from '~/utils'
import { ActionDialog } from './ActionDialog'
import { COMBINED_FILES_PREFIX } from './store'
import { formatBytes } from './utils'

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
	({ currentFile, file, onDelete, onSelect, playerStore, sourceKind }) => {
		const { path } = file
		const displayPath = stripCombinedPrefix(path).join('/')
		const isCurrent = comparePath(path, currentFile.path)
		const currentStyle = isCurrent ? 'bg-gray-200' : ''
		const playable = isAudioFile(file)
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
				className={`flex items-center justify-between hover:bg-gray-100 ${currentStyle}`}
			>
				<button
					aria-busy={
						isCurrent && playerStore.loading && !playerStore.playing
							? 'true'
							: undefined
					}
					aria-current={isCurrent ? 'true' : undefined}
					className='flex min-w-0 grow cursor-pointer items-center justify-between border-0 bg-transparent p-2 text-left disabled:cursor-default disabled:opacity-60'
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
						className='mr-2 text-gray-500 text-sm'
					>
						{status.label}
					</span>
				</button>
				{file.cached ? (
					<Button
						className='mr-2 text-red-500 hover:bg-red-50 hover:text-red-700'
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
		setTorrentInfo,
		playerStore,
		torrentInfo,
	} = store
	const [allFiles, setAllFiles] = useState([])

	useEffect(() => {
		setAllFiles([])
		setTorrentInfo(ih).catch(store.handlePlaybackError)
	}, [ih, setTorrentInfo, store.handlePlaybackError])

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

	return (
		<div className='flex h-full flex-col'>
			<Nav>
				<div className='flex-1'>
					<div className='mt-2.5 font-bold text-lg'>{torrentInfo.name}</div>
				</div>
				{showCover ? (
					<CoverImage
						className='h-28 w-28'
						files={allFiles}
						ih={ih}
						loadingLabel='Loading cover...'
						name={torrentInfo.name}
						normalizePathParts={stripCombinedPrefix}
						placeholderClassName='text-xs text-[var(--text-secondary)]'
					/>
				) : null}
			</Nav>
			<div className='mt-2.5 flex-1 touch-pan-y overflow-auto'>
				<div>
					{allFiles.map((file) => (
						<TorrentFileRow
							currentFile={currentFile}
							file={file}
							key={file.path.join('/')}
							onDelete={handleDelete}
							onSelect={handleClick}
							playerStore={playerStore}
							sourceKind={currentSourceKind}
						/>
					))}
					<StorageStatus allFiles={allFiles} store={store} />
					<CleanBookDataButtons allFiles={allFiles} store={store} />
				</div>
			</div>
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
		<div
			aria-label='Book storage status'
			className='mx-2 mt-2 grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 rounded-md bg-muted/50 px-3 py-2 text-muted-foreground text-sm'
			role='status'
		>
			<span>Server cache</span>
			<span data-server-cache-bytes={serverBytes ?? ''}>
				{serverBytes === null ? 'Unavailable' : formatBytes(serverBytes)}
			</span>
			<span>Offline on this device</span>
			<span data-offline-bytes={localBytes}>{formatBytes(localBytes)}</span>
		</div>
	)
})

export const CleanBookDataButtons = observer(({ store, allFiles }) => {
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
			<div className='flex flex-col'>
				<button
					className='flex cursor-pointer justify-center py-2 font-medium text-[#2f37ff] text-sm opacity-50 active:opacity-100 disabled:cursor-not-allowed disabled:opacity-20'
					disabled={cachedPartsLength === 0 && !hasOfflineWork}
					onClick={requestClean}
					type='button'
				>
					Clear offline data ({formatBytes(cachedPartsLength)})
				</button>
				<button
					className='flex cursor-pointer justify-center py-2 font-medium text-[#2f37ff] text-sm opacity-50 active:opacity-100'
					onClick={requestRemove}
					type='button'
				>
					Remove Book from Library
				</button>
			</div>
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
})

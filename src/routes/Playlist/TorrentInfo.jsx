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

const getLabel = (file) => {
	if (file.state === 'loading') {
		return 'loading'
	}
	if (file.cached) {
		if (file.isCombined) {
			const [start, end] = file.originalIndexes
			return `Combined (${end - start + 1} files)`
		}
		return 'loaded'
	}
	return formatBytes(file.length)
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

const TorrentFileRow = ({ currentFile, file, onDelete, onSelect }) => {
	const { path } = file
	const displayPath = stripCombinedPrefix(path).join('/')
	const currentStyle = comparePath(path, currentFile.path) ? 'bg-gray-200' : ''
	const playable = isAudioFile(file)

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
				className='flex min-w-0 grow cursor-pointer items-center justify-between border-0 bg-transparent p-2 text-left disabled:cursor-default disabled:opacity-60'
				disabled={!playable}
				onClick={handleSelect}
				type='button'
			>
				<span className='flex-1 truncate'>{displayPath}</span>
				<span className='mr-2 text-gray-500 text-sm'>{getLabel(file)}</span>
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

export const TorrentInfo = observer(({ store, showCover }) => {
	const {
		currentFile,
		filesVersion,
		ih,
		setCurrentFile,
		setTorrentInfo,
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
						/>
					))}
					<CleanBookDataButtons allFiles={allFiles} store={store} />
				</div>
			</div>
		</div>
	)
})

export const CleanBookDataButtons = observer(({ store, allFiles }) => {
	const { cleanBookData, ih, removeBook } = store
	const [pendingAction, setPendingAction] = useState(null)
	const cachedPartsLength = allFiles.reduce(
		(total, { cached, length }) => (cached ? total + length : total),
		0
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
					className='flex cursor-pointer justify-center py-2 font-medium text-[#2f37ff] text-sm opacity-50 active:opacity-100'
					onClick={requestClean}
					type='button'
				>
					Clean book data ({formatBytes(cachedPartsLength)})
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
						? 'Delete all downloaded book parts?'
						: 'Remove this book from the library?'
				}
				isOpen={pendingAction !== null}
				onCancel={cancelAction}
				onConfirm={confirmAction}
				title={pendingAction === 'clean' ? 'Clean book data?' : 'Remove book?'}
			/>
		</>
	)
})

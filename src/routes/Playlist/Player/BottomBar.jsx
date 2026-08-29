import { observer } from 'mobx-react-lite'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '~/components/ui/button'
import { storage } from '~/storage'
import { ActionDialog } from '../ActionDialog'
import { getPreloadStatus, preloadTorrent } from '../api'
import { CleanBookDataButtons } from '../TorrentInfo'
import { formatBytes } from '../utils'
import { timeFormat } from './ProgressLines'

const PRELOAD_POLL_INTERVAL_MS = 1500
const PRELOAD_MAX_POLLS = 1200

const formatPath = (path) => {
	if (!path || path.length <= 14) {
		return path
	}
	return `${path.slice(0, 4)}...${path.slice(-10)}`
}

const waitForNextPreloadPoll = (signal) =>
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
		}, PRELOAD_POLL_INTERVAL_MS)
		signal.addEventListener('abort', handleAbort, { once: true })
	})

const preloadProgress = ({ downloadedBytes, totalBytes }) => {
	if (totalBytes <= 0) {
		return formatBytes(downloadedBytes)
	}
	const percentage = Math.min(
		100,
		Math.floor((downloadedBytes / totalBytes) * 100)
	)
	return `${percentage}% (${formatBytes(downloadedBytes)} / ${formatBytes(totalBytes)})`
}

const preloadLabel = (status) => {
	if (status.state === 'completed') {
		return 'Preloaded'
	}
	if (status.state === 'failed') {
		return 'Preload failed'
	}
	return `Preload ${preloadProgress(status)}`
}

const preloadNotice = (status) => {
	if (status.state === 'completed') {
		return `Server preload complete: ${preloadProgress(status)}`
	}
	if (status.state === 'failed') {
		return status.error || 'Server preload failed.'
	}
	return `Server preload: ${preloadProgress(status)}`
}

const pollPreload = async (infoHash, signal, onStatus) => {
	for (let pollCount = 0; pollCount < PRELOAD_MAX_POLLS; pollCount += 1) {
		if (signal.aborted) {
			return 'cancelled'
		}
		// biome-ignore lint/performance/noAwaitInLoops: Each status request must finish before the next bounded poll.
		const status = await getPreloadStatus(infoHash)
		if (signal.aborted) {
			return 'cancelled'
		}
		if (status) {
			onStatus(status)
			if (status.state !== 'running') {
				return status.state
			}
		}
		if (!(await waitForNextPreloadPoll(signal))) {
			return 'cancelled'
		}
	}
	return 'timeout'
}

const NoteRow = ({ isSelected, note, onRemove, onSelect }) => {
	const handleRemove = (event) => {
		event.stopPropagation()
		onRemove(note)
	}

	const handleSelect = () => {
		onSelect(note)
	}

	return (
		<div className='relative flex gap-4 border-border border-b bg-card p-2 pr-10 hover:bg-accent'>
			<button
				className='flex min-w-0 grow cursor-pointer gap-4 border-0 bg-transparent p-0 text-left'
				onClick={handleSelect}
				type='button'
			>
				<span className='flex min-w-[8rem] shrink-0 flex-col'>
					<span
						className={`mb-3 text-muted-foreground transition-colors duration-300 ${isSelected ? 'font-bold text-primary' : ''}`}
					>
						{timeFormat(note.time)}
					</span>
					<span className='truncate text-muted-foreground text-sm'>
						{formatPath(note.path)}
					</span>
				</span>
				<span className='grow text-foreground'>{note.note}</span>
			</button>
			<button
				aria-label={`Remove note at ${timeFormat(note.time)}`}
				className='absolute top-2 right-2 border-none bg-transparent text-muted-foreground hover:text-foreground'
				onClick={handleRemove}
				type='button'
			>
				×
			</button>
		</div>
	)
}

const NotesModal = ({ notes, onClose, store }) => {
	const { setCurrentFile, torrentInfo } = store
	const [localNotes, setLocalNotes] = useState(notes ?? [])
	const [clickedNoteId, setClickedNoteId] = useState(null)
	const [noteToRemove, setNoteToRemove] = useState(null)

	const seekToNote = useCallback(
		(note) => {
			setClickedNoteId(note.id)
			setTimeout(() => setClickedNoteId(null), 2000)

			const file = torrentInfo.files.find(
				({ path }) => note.path === path.join('/')
			)
			if (file) {
				setCurrentFile(file, { path: [file.path], time: note.time }).catch(
					store.handlePlaybackError
				)
			}
		},
		[setCurrentFile, store.handlePlaybackError, torrentInfo.files]
	)

	const requestRemoveNote = useCallback((note) => {
		setNoteToRemove(note)
	}, [])

	const cancelRemoveNote = useCallback(() => {
		setNoteToRemove(null)
	}, [])

	const confirmRemoveNote = useCallback(async () => {
		if (!noteToRemove) {
			return
		}
		await storage.removeNote(noteToRemove.id)
		setLocalNotes((currentNotes) =>
			currentNotes.filter((note) => note.id !== noteToRemove.id)
		)
		setNoteToRemove(null)
	}, [noteToRemove])

	return (
		<>
			<div className='fixed inset-0 z-[1000] flex items-center justify-center'>
				<button
					aria-label='Close notes'
					className='absolute inset-0 border-0 bg-background/70'
					onClick={onClose}
					type='button'
				/>
				<div
					aria-labelledby='notes-title'
					aria-modal='true'
					className='relative flex max-h-[80vh] w-[90%] max-w-[600px] flex-col overflow-hidden rounded-lg bg-card'
					role='dialog'
				>
					<div className='flex items-center justify-between border-border border-b px-4'>
						<h2 className='text-foreground' id='notes-title'>
							Notes
						</h2>
						<button
							aria-label='Close notes'
							className='cursor-pointer border-none bg-transparent text-2xl text-muted-foreground hover:text-foreground'
							onClick={onClose}
							type='button'
						>
							×
						</button>
					</div>
					<div className='overflow-y-auto p-4'>
						{localNotes.length ? (
							localNotes.map((note) => (
								<NoteRow
									isSelected={clickedNoteId === note.id}
									key={note.id}
									note={note}
									onRemove={requestRemoveNote}
									onSelect={seekToNote}
								/>
							))
						) : (
							<div className='text-center text-muted-foreground'>No notes</div>
						)}
					</div>
				</div>
			</div>
			<ActionDialog
				description={
					noteToRemove
						? `Remove the note at ${timeFormat(noteToRemove.time)}?`
						: undefined
				}
				isOpen={noteToRemove !== null}
				onCancel={cancelRemoveNote}
				onConfirm={confirmRemoveNote}
				title='Remove note'
			/>
		</>
	)
}

const Actions = ({
	store,
	preloadStatus,
	downloadStatus,
	handlePreload,
	handleDownloadAll,
}) => {
	const [dropdownOpen, setDropdownOpen] = useState(false)

	const toggleDropdown = () => {
		setDropdownOpen((isOpen) => !isOpen)
	}

	const closeDropdown = () => {
		setDropdownOpen(false)
	}

	const selectPreload = () => {
		handlePreload()
		closeDropdown()
	}

	const selectDownloadAll = () => {
		handleDownloadAll()
		closeDropdown()
	}

	return (
		<div className='relative'>
			<Button onClick={toggleDropdown} type='button' variant='ghost'>
				Actions
			</Button>
			{dropdownOpen ? (
				<>
					<button
						aria-label='Close actions'
						className='fixed inset-0 border-0 bg-transparent'
						onClick={closeDropdown}
						type='button'
					/>
					<div className='absolute right-0 bottom-full mb-2 min-w-[200px] overflow-hidden rounded-lg border border-border bg-card shadow-lg'>
						<Button
							className='w-full justify-start'
							onClick={selectPreload}
							type='button'
							variant='ghost'
						>
							{preloadStatus}
						</Button>
						<Button
							className='w-full justify-start'
							onClick={selectDownloadAll}
							type='button'
							variant='ghost'
						>
							{downloadStatus}
						</Button>
						<div className='border-border border-t'>
							<CleanBookDataButtons
								allFiles={store.torrentInfo?.files ?? []}
								store={store}
							/>
						</div>
					</div>
				</>
			) : null}
		</div>
	)
}

export const BottomBar = observer(({ store }) => {
	const { currentFile, ih, playerStore, setNotice } = store
	const { changeRate, rate } = playerStore
	const currentPath = currentFile.path.join('/')
	const preloadControllerRef = useRef(null)
	const [notes, setNotes] = useState(null)
	const [dialog, setDialog] = useState(null)
	const [preloadStatus, setPreloadStatus] = useState('Preload')
	const [downloadStatus, setDownloadStatus] = useState('Download All')

	useEffect(
		() => () => {
			if (preloadControllerRef.current?.infoHash === ih) {
				preloadControllerRef.current.controller.abort()
				preloadControllerRef.current = null
			}
		},
		[ih]
	)

	const nextRate = useCallback(() => {
		changeRate(((value) => (value > 2 ? 0.5 : value))(rate + 0.25))
	}, [changeRate, rate])

	const closeDialog = useCallback(() => {
		setDialog(null)
	}, [])

	const confirmDialog = useCallback(
		async (value) => {
			const action = dialog?.onConfirm
			setDialog(null)
			await action?.(value)
		},
		[dialog]
	)

	const addNote = useCallback(() => {
		if (!currentPath) {
			setNotice('Choose an audio file before adding a note.')
			return
		}
		const notePath = currentPath
		const noteTime = playerStore.getProgress()
		setDialog({
			confirmLabel: 'Add note',
			inputLabel: 'Note',
			onConfirm: async (note) => {
				const trimmedNote = note.trim()
				if (!trimmedNote) {
					return
				}
				await storage.addNote(ih, notePath, noteTime, trimmedNote)
			},
			title: 'Add note',
		})
	}, [currentPath, ih, playerStore, setNotice])

	const showNotes = useCallback(async () => {
		const fetchedNotes = await storage.getAllNotes(ih)
		setNotes(fetchedNotes)
	}, [ih])

	const applyPreloadStatus = useCallback(
		(status) => {
			setPreloadStatus(preloadLabel(status))
			setNotice(preloadNotice(status))
		},
		[setNotice]
	)

	const preloadBook = useCallback(async () => {
		preloadControllerRef.current?.controller.abort()
		const controller = new AbortController()
		preloadControllerRef.current = { controller, infoHash: ih }
		setPreloadStatus('Starting preload...')
		setNotice('Starting server preload...')
		try {
			await preloadTorrent(ih)
			if (controller.signal.aborted) {
				return
			}
			const outcome = await pollPreload(
				ih,
				controller.signal,
				applyPreloadStatus
			)
			if (outcome === 'timeout') {
				setPreloadStatus('Preload still running')
				setNotice(
					'Server preload is still running after 30 minutes. Select Preload to check it again.'
				)
			}
		} catch (error) {
			if (!controller.signal.aborted) {
				setPreloadStatus('Preload failed')
				setNotice(error instanceof Error ? error.message : String(error))
			}
		} finally {
			if (preloadControllerRef.current?.controller === controller) {
				preloadControllerRef.current = null
			}
		}
	}, [applyPreloadStatus, ih, setNotice])

	const handlePreload = useCallback(() => {
		if (!ih) {
			return
		}
		setDialog({
			description:
				'Preload only if you are authorized to download and share this book. The server transfer may upload pieces to peers. Data is not stored offline on this device until you play or download it.',
			onConfirm: preloadBook,
			title: 'Preload book?',
		})
	}, [ih, preloadBook])

	const downloadAllFiles = useCallback(async () => {
		setDownloadStatus('Downloading...')
		try {
			const result = await store.downloadAllFiles()
			setDownloadStatus(result ? 'Done' : 'Failed')
		} catch (error) {
			setDownloadStatus('Error')
			setNotice(error instanceof Error ? error.message : String(error))
		} finally {
			setTimeout(() => setDownloadStatus('Download All'), 3000)
		}
	}, [setNotice, store])

	const handleDownloadAll = useCallback(() => {
		if (!ih) {
			return
		}
		setDialog({
			description:
				'Download only if you are authorized to obtain and share this book. This stores every file on your device, and the peer-to-peer transfer may upload pieces to others.',
			onConfirm: downloadAllFiles,
			title: 'Download all files?',
		})
	}, [downloadAllFiles, ih])

	const copyInfoHash = useCallback(
		async (event) => {
			const button = event.currentTarget
			try {
				await navigator.clipboard.writeText(ih)
				button.classList.add('show-popover')
				setTimeout(() => button.classList.remove('show-popover'), 1000)
			} catch {
				setNotice('Unable to copy infohash')
			}
		},
		[ih, setNotice]
	)

	const closeNotes = useCallback(() => {
		setNotes(null)
	}, [])

	return (
		<>
			<Button className='w-12' onClick={nextRate} type='button' variant='ghost'>
				{`x${rate}`}
			</Button>
			<Button onClick={addNote} type='button' variant='ghost'>
				+Note
			</Button>
			<Button onClick={showNotes} type='button' variant='ghost'>
				Notes
			</Button>
			<Actions
				downloadStatus={downloadStatus}
				handleDownloadAll={handleDownloadAll}
				handlePreload={handlePreload}
				preloadStatus={preloadStatus}
				store={store}
			/>
			<Button
				className='group relative w-8'
				onClick={copyInfoHash}
				title='Copy infohash'
				type='button'
				variant='ghost'
			>
				[ih]
				<span className='invisible absolute bottom-full left-1/2 -translate-x-1/2 whitespace-nowrap rounded bg-popover px-2 py-1 text-popover-foreground text-sm opacity-0 transition-all duration-200 group-[.show-popover]:visible group-[.show-popover]:opacity-100'>
					Copied infohash
				</span>
			</Button>
			{notes === null ? null : (
				<NotesModal notes={notes} onClose={closeNotes} store={store} />
			)}
			<ActionDialog
				confirmLabel={dialog?.confirmLabel}
				description={dialog?.description}
				inputLabel={dialog?.inputLabel}
				isOpen={dialog !== null}
				onCancel={closeDialog}
				onConfirm={confirmDialog}
				title={dialog?.title ?? ''}
			/>
		</>
	)
})

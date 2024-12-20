import React, { useState } from 'react'
import { observer } from 'mobx-react-lite'
import { storage } from '~/storage'
import { timeFormat } from './ProgressLines'
import { preloadTorrent } from '../api'
import { CleanBookDataButtons } from '../TorrentInfo'
import { Button } from '~/components/ui/button'

const formatPath = (path) => {
	if (!path || path.length <= 14) return path
	return path.slice(0, 4) + '...' + path.slice(-10)
}

const NotesModal = ({ notes, onClose, store }) => {
	const { setCurrentFile, torrentInfo } = store
	const [localNotes, setLocalNotes] = useState(notes)
	const [clickedNoteId, setClickedNoteId] = useState(null)
	if (!localNotes?.length) return null

	const seekToNote = note => {
		setClickedNoteId(note.id)
		setTimeout(() => setClickedNoteId(null), 2000)

		const pathStr = note.path
		//search file in torrent info
		const file = torrentInfo.files.find(({ path: p }) => pathStr === p.join('/'))
		if (file) {
			setCurrentFile(file, { time: note.time, path: [file.path] })
			return
		}
	}

	const removeNote = async (e, note) => {
		e.stopPropagation()
		if (!window.confirm('Remove note?')) return
		await storage.removeNote(note.id)
		setLocalNotes(localNotes.filter(n => n.id !== note.id))
	}

	return (
		<div className="fixed inset-0 bg-background/70 flex justify-center items-center z-[1000]" onClick={onClose}>
			<div className="bg-card rounded-lg w-[90%] max-w-[600px] max-h-[80vh] overflow-hidden flex flex-col" onClick={e => e.stopPropagation()}>
				<div className="flex justify-between items-center px-4 border-b border-border">
					<h3 className="text-foreground">Notes</h3>
					<button onClick={onClose} className="bg-transparent border-none text-2xl cursor-pointer text-muted-foreground hover:text-foreground">×</button>
				</div>
				<div className="overflow-y-auto p-4">
					{localNotes.map(note => (
						<div key={note.id} className="flex gap-4 p-2 pr-10 border-b border-border bg-card hover:bg-accent cursor-pointer relative" onClick={() => seekToNote(note)}>
							<div className="flex flex-col min-w-[8rem] flex-shrink-0">
								<div className={`mb-3 text-muted-foreground transition-colors duration-300 ${clickedNoteId === note.id ? 'text-primary font-bold' : ''}`}>
									{timeFormat(note.time)}
								</div>
								<div className="text-muted-foreground text-sm truncate">
									{formatPath(note.path)}
								</div>
							</div>
							<div className="flex-grow text-foreground">
								{note.note}
							</div>
							<button onClick={(e) => removeNote(e, note)} className="absolute right-2 top-2 bg-transparent border-none text-muted-foreground hover:text-foreground">×</button>
						</div>
					))}
				</div>
			</div>
		</div>
	)
}

const Actions = ({ store, preloadStatus, optimizeStatus, downloadStatus, handlePreload, handleOptimize, handleDownloadAll }) => {
	const [dropdownOpen, setDropdownOpen] = useState(false)

	return (
		<div className="relative">
			<Button onClick={() => setDropdownOpen(!dropdownOpen)} variant="ghost" > Actions </Button>
			{dropdownOpen && (
				<>
					<div
						className="fixed inset-0"
						onClick={() => setDropdownOpen(false)}
					/>
					<div className="absolute bottom-full right-0 mb-2 bg-card rounded-lg overflow-hidden shadow-lg min-w-[200px] border border-border">
						<Button variant="ghost" className="w-full justify-start"
							onClick={() => {
								handlePreload();
								setDropdownOpen(false);
							}}
						>
							{preloadStatus}
						</Button>
						<Button variant="ghost" className="w-full justify-start"
							onClick={() => {
								handleOptimize();
								setDropdownOpen(false);
							}}
						>
							{optimizeStatus}
						</Button>
						<Button variant="ghost" className="w-full justify-start"
							onClick={() => {
								handleDownloadAll();
								setDropdownOpen(false);
							}}
						>
							{downloadStatus}
						</Button>
						<div className="border-t border-border">
							<CleanBookDataButtons store={store} allFiles={store.torrentInfo?.files || []} />
						</div>
					</div>
				</>
			)}
		</div>
	)
}

export const BottomBar = observer(({ store }) => {
	const { playerStore, ih, currentFile } = store
	const { rate, changeRate } = playerStore
	const nextRate = () => changeRate((r => (r > 2 ? 0.5 : r))(rate + 0.25))
	const [notes, setNotes] = useState(null)
	const [preloadStatus, setPreloadStatus] = useState('Preload')
	const [optimizeStatus, setOptimizeStatus] = useState('Optimize')
	const [downloadStatus, setDownloadStatus] = useState('Download All')

	const addNote = async () => {
		const note = prompt('Enter note:')
		if (!note) return
		const { time } = playerStore
		const path = currentFile.path.join('/')
		await storage.addNote(ih, path, time, note)
	}

	const showNotes = async () => {
		const fetchedNotes = await storage.getAllNotes(ih)
		setNotes(fetchedNotes)
	}

	const handlePreload = async () => {
		if (!ih) return
		if (!window.confirm('This will preload the book to the server. The data will not be loaded to your device until you start playing. Continue?')) {
			return
		}
		try {
			const status = await preloadTorrent(ih)
			window.alert(status)
		} catch (err) {
			window.alert(err.message)
		}
	}

	const handleOptimize = async () => {
		if (!ih) return
		if (!window.confirm('This will combine all files into one. Continue?')) {
			return
		}
		setOptimizeStatus('Processing...')
		try {
			const result = await store.concatAllFiles()
			if (result) {
				setOptimizeStatus('Done')
			} else {
				setOptimizeStatus('Failed')
			}
		} catch (err) {
			setOptimizeStatus('Error')
			console.error(err)
		} finally {
			setTimeout(() => setOptimizeStatus('Optimize'), 3000)
		}
	}

	const handleDownloadAll = async () => {
		if (!ih) return
		if (!window.confirm('This will download all files to your device. Continue?')) {
			return
		}
		setDownloadStatus('Downloading...')
		try {
			const result = await store.downloadAllFiles()
			if (result) {
				setDownloadStatus('Done')
			} else {
				setDownloadStatus('Failed')
			}
		} catch (err) {
			setDownloadStatus('Error')
			console.error(err)
		} finally {
			setTimeout(() => setDownloadStatus('Download All'), 3000)
		}
	}

	return (
		<>
			<Button onClick={nextRate} variant="ghost" className="w-12" > {`x${rate}`} </Button>
			<Button onClick={addNote} variant="ghost" > +Note </Button>
			<Button onClick={showNotes} variant="ghost" > Notes </Button>
			<Actions
				store={store}
				preloadStatus={preloadStatus}
				optimizeStatus={optimizeStatus}
				downloadStatus={downloadStatus}
				handlePreload={handlePreload}
				handleOptimize={handleOptimize}
				handleDownloadAll={handleDownloadAll}
			/>
			<Button
				onClick={(e) => {
					navigator.clipboard.writeText(store.ih);
					const button = e.currentTarget;
					button.classList.add('show-popover');
					setTimeout(() => button.classList.remove('show-popover'), 1000);
				}}
				variant="ghost"

				className="w-8 relative group"
				title="Copy infohash"
			>
				[ih]
				<div className="absolute bottom-full left-1/2 -translate-x-1/2 bg-popover text-popover-foreground px-2 py-1 rounded text-sm whitespace-nowrap opacity-0 invisible group-[.show-popover]:opacity-100 group-[.show-popover]:visible transition-all duration-200">
					Copied infohash
				</div>
			</Button>
			{notes && <NotesModal notes={notes} onClose={() => setNotes(null)} store={store} />}
		</>
	)
})

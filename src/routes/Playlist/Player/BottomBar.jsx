import React, { useState } from 'react'
import { observer } from 'mobx-react-lite'
import { storage } from '~/storage'
import { timeFormat } from './ProgressLines'
import { preloadTorrent } from '../api'

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
		<div className="fixed inset-0 bg-black/70 flex justify-center items-center z-[1000]" onClick={onClose}>
			<div className="bg-white rounded-lg w-[90%] max-w-[600px] max-h-[80vh] overflow-hidden flex flex-col" onClick={e => e.stopPropagation()}>
				<div className="flex justify-between items-center px-4 border-b border-gray-200">
					<h3>Notes</h3>
					<button onClick={onClose} className="bg-transparent border-none text-2xl cursor-pointer">×</button>
				</div>
				<div className="overflow-y-auto p-4">
					{localNotes.map(note => (
						<div key={note.id} className="flex gap-4 p-2 pr-10 border-b border-gray-200 bg-white hover:bg-gray-50 cursor-pointer relative" onClick={() => seekToNote(note)}>
							<div className="flex flex-col min-w-[8rem] flex-shrink-0">
								<div className={`mb-3 text-gray-600 transition-colors duration-300 ${clickedNoteId === note.id ? 'text-blue-600 font-bold' : ''}`}>
									{timeFormat(note.time)}
								</div>
								<div className="text-gray-500 text-sm truncate">
									{formatPath(note.path)}
								</div>
							</div>
							<div className="flex-grow">
								{note.note}
							</div>
							<button onClick={(e) => removeNote(e, note)} className="absolute right-2 top-2 bg-transparent border-none text-gray-400 hover:text-gray-600">×</button>
						</div>
					))}
				</div>
			</div>
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
			<div
				onClick={nextRate}
				className="font-bold h-8 w-12 flex justify-center items-center cursor-pointer opacity-60 hover:opacity-100 transition-opacity duration-200"
			>
				{`x${rate}`}
			</div>
			<div
				onClick={addNote}
				className="font-bold h-8 px-3 flex justify-center items-center cursor-pointer opacity-60 hover:opacity-100 transition-opacity duration-200"
			>
				+Note
			</div>
			<div
				onClick={showNotes}
				className="font-bold h-8 px-3 flex justify-center items-center cursor-pointer opacity-60 hover:opacity-100 transition-opacity duration-200"
			>
				Notes
			</div>
			<div
				onClick={handlePreload}
				className="font-bold h-8 px-3 flex justify-center items-center cursor-pointer opacity-60 hover:opacity-100 transition-opacity duration-200"
			>
				{preloadStatus}
			</div>
			<div
				onClick={(e) => {
					navigator.clipboard.writeText(store.ih);
					const button = e.currentTarget;
					button.classList.add('show-popover');
					setTimeout(() => button.classList.remove('show-popover'), 1000);
				}}
				className="font-bold h-8 w-8 flex justify-center items-center cursor-pointer opacity-60 hover:opacity-100 transition-opacity duration-200 relative group"
				title="Copy infohash"
			>
				[ih]
				<div className="absolute bottom-full left-1/2 -translate-x-1/2 bg-black/80 text-white px-2 py-1 rounded text-sm whitespace-nowrap opacity-0 invisible group-[.show-popover]:opacity-100 group-[.show-popover]:visible transition-all duration-200">
					Copied infohash
				</div>
			</div>
			<div
				onClick={handleOptimize}
				className="font-bold h-8 px-3 flex justify-center items-center cursor-pointer opacity-60 hover:opacity-100 transition-opacity duration-200"
			>
				{optimizeStatus}
			</div>
			<div
				onClick={handleDownloadAll}
				className="font-bold h-8 px-3 flex justify-center items-center cursor-pointer opacity-60 hover:opacity-100 transition-opacity duration-200"
			>
				{downloadStatus}
			</div>
			{notes && <NotesModal notes={notes} onClose={() => setNotes(null)} store={store} />}
		</>
	)
})

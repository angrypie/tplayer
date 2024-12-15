import React, { useState } from 'react'
import { observer } from 'mobx-react-lite'
import { storage } from '~/storage'
import { timeFormat } from './ProgressLines'

const formatPath = (path) => {
	if (!path || path.length <= 14) return path
	return path.slice(0, 4) + '...' + path.slice(-10)
}

const NotesModal = ({ notes, onClose, store }) => {
	const { setCurrentFile, torrentInfo } = store
	const [localNotes, setLocalNotes] = useState(notes)
	if (!localNotes?.length) return null

	const seekToNote = note => {
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
		<div className="modal-overlay">
			<div className="modal-content">
				<div className="modal-header">
					<h3>Notes</h3>
					<button onClick={onClose}>×</button>
				</div>
				<div className="notes-list">
					{localNotes.map(note => (
						<div key={note.id} className="note-item bg-white pointer" onClick={() => seekToNote(note)}>
							<div className="note-meta" >
								<div className="note-time mb3">{timeFormat(note.time)}</div>
								<div className="note-path">
									{formatPath(note.path)}
								</div>
							</div>
							<div className="note-text">{note.note}</div>
							<button 
								onClick={(e) => removeNote(e, note)}
								className="remove-btn"
							>
								×
							</button>
						</div>
					))}
				</div>
			</div>
			<style jsx>{`
				.modal-overlay {
					position: fixed;
					top: 0;
					left: 0;
					right: 0;
					bottom: 0;
					background: rgba(0, 0, 0, 0.7);
					display: flex;
					justify-content: center;
					align-items: center;
					z-index: 1000;
				}
				.modal-content {
					background: white;
					border-radius: 8px;
					width: 90%;
					max-width: 600px;
					max-height: 80vh;
					overflow: hidden;
					display: flex;
					flex-direction: column;
				}
				.modal-header {
					display: flex;
					justify-content: space-between;
					align-items: center;
					padding: 1rem;
					border-bottom: 1px solid #eee;
				}
				.modal-header button {
					background: none;
					border: none;
					font-size: 1.5rem;
					cursor: pointer;
				}
				.notes-list {
					overflow-y: auto;
					padding: 1rem;
				}
				.note-item {
					display: flex;
					gap: 1rem;
					padding: 0.5rem;
					padding-right: 2.5rem;
					border-bottom: 1px solid #eee;
					position: relative;
				}
				.note-meta {
					display: flex;
					flex-direction: column;
					min-width: 8rem;
					flex-shrink: 0;
				}
				.note-time {
					color: #666;
				}
				.note-path {
					color: #888;
					font-size: 0.8rem;
					white-space: nowrap;
					overflow: hidden;
					text-overflow: ellipsis;
				}
				.note-text {
					flex: 1;
					align-self: center;
					overflow: hidden;
					text-overflow: ellipsis;
				}
				.remove-btn {
					position: absolute;
					right: 0.5rem;
					top: 50%;
					transform: translateY(-50%);
					background: none;
					border: none;
					color: #999;
					font-size: 1.2rem;
					cursor: pointer;
					padding: 0.2rem 0.5rem;
					border-radius: 4px;
				}
				.remove-btn:hover {
					color: #ff4444;
					background: #ffeeee;
				}
			`}</style>
		</div>
	)
}

export const BottomBar = observer(({ store }) => {
	const { playerStore, ih, currentFile } = store
	const { rate, changeRate } = playerStore
	const nextRate = () => changeRate((r => (r > 2 ? 0.5 : r))(rate + 0.25))
	const [notes, setNotes] = useState(null)

	const addNote = async () => {
		const note = prompt('Enter note:')
		if (!note) return
		const time = playerStore.getProgress()
		const path = currentFile?.path || null
		if (!path || time <= 0) {
			alert('No file selected or time is not set')
			return
		}
		await storage.addNote(ih, path.join('/'), time, note)
	}

	const showNotes = async () => {
		const fetchedNotes = await storage.getAllNotes(ih)
		setNotes(fetchedNotes)
	}

	return (
		<>
			<div
				onClick={nextRate}
				className='b h2 w3 flex justify-center items-center pointer'
			>
				{`x${rate}`}
			</div>
			<div
				onClick={addNote}
				className='b h2 ph3 flex justify-center items-center pointer'
			>
				Add Note
			</div>
			<div
				onClick={showNotes}
				className='b h2 ph3 flex justify-center items-center pointer'
			>
				Show Notes
			</div>
			{notes && <NotesModal notes={notes} onClose={() => setNotes(null)} store={store} />}
		</>
	)
})

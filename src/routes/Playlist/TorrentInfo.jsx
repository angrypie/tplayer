import React, { useEffect, useState, useRef } from 'react'
import { formatBytes } from './utils'
import { observer } from 'mobx-react-lite'
import { comparePath } from '~/utils'

export const TorrentInfo = observer(({ store }) => {
	const { ih, torrentInfo, setTorrentInfo, currentFile, setCurrentFile, deleteFile } = store

	useEffect(() => {
		setTorrentInfo(ih)
	}, [ih, setTorrentInfo])

	const longPressTimerRef = useRef(null)
	const [longPressedFile, setLongPressedFile] = useState(null)

	const handleTouchStart = (file) => {
		longPressTimerRef.current = setTimeout(() => {
			setLongPressedFile(file)
			if (window.confirm('Delete this file?')) {
				deleteFile(file)
			}
		}, 500) // 500ms for long press
	}

	const handleTouchEnd = () => {
		if (longPressTimerRef.current) {
			clearTimeout(longPressTimerRef.current)
		}
		setLongPressedFile(null)
	}

	const handleClick = (file) => {
		if (longPressedFile === file) {
			return // Don't trigger click if it was a long press
		}
		setCurrentFile(file)
	}

	const getColor = (path) => {
		if (path[0] === '_combined') {
			return 'bg-[#5a3fd6] text-white'
		}
		return ''
	}

	const getLabel = ({ cached, length, state }) => {
		if (state === 'loading') {
			return 'loading'
		}
		if (cached) {
			return 'loaded'
		}
		return formatBytes(length)
	}

	return (
		<div className='flex flex-col h-full'>
			<div className='h-[100px] mx-4'>
				<div className='text-4xl font-bold leading-tight'>Book</div>
				<div className='text-2xl font-bold opacity-50 leading-normal truncate'>{torrentInfo.name}</div>
			</div>
			<div className='flex-1 overflow-auto mt-2.5 touch-pan-y'>
				<div>
					{torrentInfo.files.map((file, i) => {
						const { path } = file
						return (
							<div
								key={i}
								onClick={() => handleClick(file)}
								onTouchStart={() => handleTouchStart(file)}
								onTouchEnd={handleTouchEnd}
								onMouseDown={() => handleTouchStart(file)}
								onMouseUp={handleTouchEnd}
								onMouseLeave={handleTouchEnd}
								className={`h-10 px-4 flex justify-between items-center cursor-pointer ${getColor(path)} ${longPressedFile === file ? 'opacity-50' : ''}`}
							>
								<div>{path.join('/')}</div>
								<div className={`font-bold ${comparePath(currentFile.path, path) ? 'text-white' : file.cached ? 'text-[#5a3fd6]' : ''}`}>
									{getLabel(file)}
								</div>
							</div>
						)
					})}
				</div>
				<CleanBookDataButtons store={store} />
			</div>
		</div>
	)
})

const CleanBookDataButtons = observer(({ store }) => {
	const { torrentInfo, cleanBookData, removeBook, ih } = store
	const cachedPartsLength = torrentInfo.files.reduce(
		(total, { cached, length }) => (!cached ? total : total + length),
		0
	)

	const clean = () =>
		window.confirm('Are you sure to delete all downloaded book parts?')
			? cleanBookData(ih)
			: null

	const remove = () =>
		window.confirm('Are you sure to remove this book from library?')
			? removeBook(ih).then((ok) => ok && window.history.pushState(null, null, '/'))
			: null

	return (
		<div className='flex flex-col'>
			<div onClick={clean} className='flex justify-center py-2 cursor-pointer text-[#2f37ff] font-medium text-sm opacity-50 active:opacity-100'>
				Clean book data ({formatBytes(cachedPartsLength)})
			</div>
			<div onClick={remove} className='flex justify-center py-2 cursor-pointer text-[#2f37ff] font-medium text-sm opacity-50 active:opacity-100'>
				Remove Book from Library
			</div>
		</div>
	)
})

import React, { useEffect } from 'react'
import { formatBytes } from './utils'
import { observer } from 'mobx-react-lite'
import { comparePath } from '~/utils'

export const TorrentInfo = observer(({ store }) => {
	const { ih, torrentInfo, setTorrentInfo } = store

	useEffect(() => {
		setTorrentInfo(ih)
	}, [ih, setTorrentInfo])

	return (
		<div className='flex flex-col h-full'>
			<div className='h-[100px] mx-4'>
				<div className='text-4xl font-bold leading-tight'>Book</div>
				<div className='text-2xl font-bold opacity-50 leading-normal truncate'>{torrentInfo.name}</div>
			</div>
			<div className='flex-1 overflow-auto mt-2.5 touch-pan-y'>
				<div>
					<PlayList store={store} />
				</div>
				<CleanBookDataButtons store={store} />
			</div>
		</div>
	)
})

const PlayList = observer(({ store }) => {
	const { currentFile, torrentInfo, setCurrentFile } = store

	const getColor = path =>
		comparePath(currentFile.path, path)
			? 'bg-[#2f37ff] text-white'
			: 'hover:bg-gray-50 bg-white'

	const getLabel = ({ cached, length, state }) => {
		let label = cached ? 'loaded' : formatBytes(length)
		label = state === 'loading' ? 'loading' : label
		return label
	}

	return torrentInfo.files.map((file, i) => {
		const { path } = file
		return (
			<div
				key={i}
				onClick={() => setCurrentFile(file)}
				className={`h-10 px-4 flex justify-between items-center cursor-pointer ${getColor(path)}`}
			>
				<div>{path.join('/')}</div>
				<div className={`font-bold ${comparePath(currentFile.path, path) ? 'text-white' : file.cached ? 'text-[#5a3fd6]' : ''}`}>
					{getLabel(file)}
				</div>
			</div>
		)
	})
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

import React, { useEffect, useRef } from 'react'
import { formatBytes } from './utils'
import { observer } from 'mobx-react-lite'
import { disableBodyScroll, enableBodyScroll } from 'body-scroll-lock'
import { comparePath } from '~/utils'

export const TorrentInfo = observer(({ store }) => {
	const { ih, torrentInfo, setTorrentInfo } = store

	const listEl = useRef(null)

	useEffect(() => {
		const current = listEl.current
		disableBodyScroll(current)
		setTorrentInfo(ih)
		return () => enableBodyScroll(current)
	}, [ih, setTorrentInfo])

	return (
		<div className='container'>
			<div className='header'>
				<div className='f2 b lh-title'>Book</div>
				<div className='f3 b o-50 lh-copy truncate'>{torrentInfo.name}</div>
			</div>
			<div className='file-list-container' ref={listEl}>
				<div className='file-list'>
					<PlayList store={store} />
				</div>
				<CleanBookDataButton store={store} />
			</div>
			<style jsx>{`
				.container {
					display: flex;
					flex-direction: column;
					max-height: 100%;
				}

				.header {
					height: 100px;
					margin: 0 15px;
				}

				.file-list-container {
					flex: 0 1 auto;
					overflow: scroll;
					margin-top: 10px;
					-webkit-overflow-scrolling: touch;
				}

				.file-list {
				}
			`}</style>
		</div>
	)
})

const PlayList = observer(({ store }) => {
	const { currentFile, torrentInfo, setCurrentFile } = store
	const position = 'file flex justify-between items-center '
	const appearance = 'pointer bg-animate-ns'
	const getColor = path =>
		comparePath(currentFile.path, path)
			? 'active white'
			: 'hover-bg-near-white-ns bg-white'

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
				className={`${position} ${appearance} ${getColor(path)}`}
			>
				<div>{path.join('/')}</div>
				<div className='b'>{getLabel(file)}</div>

				<style jsx>{`
					.file {
						height: 2.5rem;
						padding: 0 15px;
					}

					.active {
						background-color: #2f37ff;
					}
				`}</style>
			</div>
		)
	})
})

const CleanBookDataButton = observer(({ store }) => {
	const { torrentInfo, cleanBookData, ih } = store
	const cachedPartsLength = torrentInfo.files.reduce(
		(total, { cached, length }) => (!cached ? total : total + length),
		0
	)

	const clean = () =>
		window.confirm('Are you sure to delete all downloaded book parts?')
			? cleanBookData(ih)
			: null

	if(cachedPartsLength === 0) {
		return null
	}
	return (
		<div onClick={clean} className='flex justify-center pv2 pointer'>
			Clean book data ({formatBytes(cachedPartsLength)})
			<style jsx>{`
				div {
					color: #2f37ff;
					font-weight: 500;
					font-size: 14px;
					opacity: 0.5;
				}

				div:active {
					opacity: 1;
				}
			`}</style>
		</div>
	)
})

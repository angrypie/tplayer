import React, { useEffect, useState, useRef } from 'react'
import { getTorrentInfo } from './api'
import { formatBytes } from './utils'

import { disableBodyScroll, enableBodyScroll } from 'body-scroll-lock'

export const TorrentInfo = ({ ih, selectFile }) => {
	const [info, setInfo] = useState({ name: '', files: [], length: 0 })
	const [currentFile, setCurrentFile] = useState({ path: [] })
	const listEl = useRef(null)

	useEffect(() => {
		const current = listEl.current
		disableBodyScroll(current)
		async function run() {
			const info = await getTorrentInfo(ih)
			const { name = '', files = [], length = 0 } = info
			setInfo({ name: info['name.utf-8'] || name, files, length })
		}
		run()
		return () => enableBodyScroll(current)
	}, [ih])

	return (
		<div className='container'>
			<div className='header'>
				<div className='f2 b lh-title'>Book</div>
				<div className='f3 b o-50 lh-copy truncate'>{info.name}</div>
			</div>
			<div className='file-list-container' ref={listEl}>
				<div className='file-list'>
					<PlayList
						files={info.files}
						current={currentFile}
						selectFile={f => {
							setCurrentFile(f)
							selectFile({ ...f, ih })
						}}
					/>
				</div>
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
}

const PlayList = ({ files, selectFile, current = [] }) => {
	const position = 'file flex justify-between items-center '
	const appearance = 'pointer bg-animate-ns'
	const getColor = path =>
		current.path.join('/') === path.join('/')
			? 'active white'
			: 'hover-bg-near-white-ns bg-white'

	return files.map(({ path, length }, i) => (
		<div key={i} onClick={() => selectFile({ path, length })}>
			<div className={`${position} ${appearance} ${getColor(path)}`}>
				<div>{path.join('/')}</div>
				<div className='b'>{formatBytes(length)}</div>
			</div>

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
	))
}

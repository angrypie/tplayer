import React from 'react'
import { TorrentInfo } from './TorrentInfo'
import { File } from './File'
import { Nav } from './Nav'
import { useBookStores } from './store'

function App({ params: { ih } }) {
	const bookStores = useBookStores({ ih })
	const bookStore = bookStores.bookStore

	return (
		<div style={{ height: `${window.innerHeight}px` }} className="w-full">
			<div className="h-10">
				<Nav />
			</div>
			<div style={{ height: `calc(${window.innerHeight}px - 10rem - 2.5rem)` }}>
				<TorrentInfo store={bookStore} />
			</div>
			<div className="h-40">
				<File store={bookStore} />
			</div>
		</div>
	)
}

export default App

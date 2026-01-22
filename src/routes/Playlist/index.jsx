import React, { useEffect, useState } from 'react'
import { TorrentInfo } from './TorrentInfo'
import { File } from './File'
import { Nav } from './Nav'
import { useBookStores } from './store'

const COVER_VISIBILITY_KEY = 'tplayer:cover-visible'

function App({ params: { ih } }) {
	const bookStores = useBookStores({ ih })
	const bookStore = bookStores.bookStore
	const [showCover, setShowCover] = useState(() => {
		if (typeof window === 'undefined') {
			return false
		}
		const stored = window.localStorage.getItem(COVER_VISIBILITY_KEY)
		return stored ? stored === 'true' : false
	})

	useEffect(() => {
		if (typeof window === 'undefined') {
			return
		}
		window.localStorage.setItem(COVER_VISIBILITY_KEY, String(showCover))
	}, [showCover])

	const handleToggleCover = () => {
		setShowCover((prev) => !prev)
	}

	return (
		<div style={{ height: `${window.innerHeight}px` }} className="w-full">
			<div className="h-10">
				<Nav showCover={showCover} onToggleCover={handleToggleCover} />
			</div>
			<div style={{ height: `calc(${window.innerHeight}px - 10rem - 2.5rem)` }}>
				<TorrentInfo store={bookStore} showCover={showCover} />
			</div>
			<div className="h-40">
				<File store={bookStore} />
			</div>
		</div>
	)
}

export default App

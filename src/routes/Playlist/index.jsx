import { useCallback, useEffect, useState } from 'react'
import { File } from './File'
import { Nav } from './Nav'
import { useBookStores } from './store'
import { TorrentInfo } from './TorrentInfo'

const COVER_VISIBILITY_KEY = 'tplayer:cover-visible'

function App({ params: { ih } }) {
	const { bookStore } = useBookStores({ ih })
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

	const handleToggleCover = useCallback(() => {
		setShowCover((prev) => !prev)
	}, [])

	return (
		<div className='w-full' style={{ height: `${window.innerHeight}px` }}>
			<div className='h-10'>
				<Nav onToggleCover={handleToggleCover} showCover={showCover} />
			</div>
			<div style={{ height: `calc(${window.innerHeight}px - 10rem - 2.5rem)` }}>
				<TorrentInfo showCover={showCover} store={bookStore} />
			</div>
			<div className='h-40'>
				<File store={bookStore} />
			</div>
		</div>
	)
}

export default App

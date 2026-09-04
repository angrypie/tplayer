import { useCallback, useEffect, useState } from 'react'
import { PageShell } from '~/components/layout/Page'
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
		<PageShell>
			<Nav onToggleCover={handleToggleCover} showCover={showCover} />
			<div className='min-h-0 flex-1'>
				<TorrentInfo key={ih} showCover={showCover} store={bookStore} />
			</div>
			<File store={bookStore} />
		</PageShell>
	)
}

export default App

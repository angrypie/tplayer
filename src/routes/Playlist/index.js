import React from 'react'
import { TorrentInfo } from './TorrentInfo'
import { File } from './File'
import { Nav } from './Nav'
import { useBookStores } from './store'

function App({ params: { ih } }) {

	const bookStores = useBookStores({ ih })
	const store = bookStores.bookStore

	return (
		<div className='container'>
			<div className='nav'>
				<Nav />
			</div>
			<div className='info'>
				<TorrentInfo store={store} />
			</div>
			<div className='player'>
				<File playerStore={bookStores.playerStore} store={store} />
			</div>
			<style jsx>{`
				.container {
					height: ${window.innerHeight}px;
				}

				.nav {
					height: 40px;
				}

				.info {
					height: calc(${window.innerHeight}px - 40px - 150px);
				}

				.player {
					height: 150px;
				}
			`}</style>
		</div>
	)
}

export default App

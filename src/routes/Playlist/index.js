import React from 'react'
import { TorrentInfo } from './TorrentInfo'
import { File } from './File'
import { Nav } from './Nav'
import { useLocalStore } from 'mobx-react-lite'

function App() {
	//Antony
	//const ih = '5A0EEED914F871D1FDDA8A0E11B1186E3F4AB6DB'
	//1984
	const ih = '2336697F0C677ACEA47608E884CD584F9480B26B'

	const store  = useLocalStore(() => ({
		ih,
		file: {},
		setFile(file) {
			store.file = {...file}
		}
	}))

	return (
		<div className='container'>
			<div className='nav'>
				<Nav />
			</div>
			<div className='info'>
				<TorrentInfo store={store} />
			</div>
			<div className='player'>
				<File store={store} />
			</div>
			<style>{`
				html, body {
					font-family: system-ui;
				}
			`}</style>
			<style jsx>{`
				.container {
					height: ${window.innerHeight}px;
					max-width: 500px;
					display: flex;
					flex-direction: column;
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

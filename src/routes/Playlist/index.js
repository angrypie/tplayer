import React, { useState } from 'react'
import { TorrentInfo } from './TorrentInfo'
import { File } from './File'
import { Nav } from './Nav'

function App() {
	//const ih = '558C31000CCFF91B51670B901D5512B3940998B8'
	const ih = '5A0EEED914F871D1FDDA8A0E11B1186E3F4AB6DB'

	const [file, setFile] = useState({})

	return (
		<div className='container'>
			<div className='nav'>
				<Nav />
			</div>
			<div className='info'>
				<TorrentInfo ih={ih} selectFile={setFile} />
			</div>
			<div className='player'>
				<File {...file} />
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

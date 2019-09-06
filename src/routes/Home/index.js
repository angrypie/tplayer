import React from 'react'
import { Link } from 'wouter'
import { Search } from './Search'

const Home = () => {
	return (
		<div className='container'>
			<Search />
			<div className="flex flex-column">
			<Link href='/playlist/4C5177EC005D4BDEB2C6CFE880EDCB6E0268A36E'>
				Сердца трех
			</Link>
			<Link href='/playlist/1C6BAF75EA2FC90C29DB5325FF4881F5E78379A2'>
				Homo Deus
			</Link>
			</div>
		</div>
	)
}

export default Home

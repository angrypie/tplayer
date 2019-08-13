import React from 'react'
import { Link } from 'wouter'
import { Search } from './Search'

const Home = () => {
	return (
		<div className='container'>
			<Search />
			<Link href='/playlist/4C5177EC005D4BDEB2C6CFE880EDCB6E0268A36E'>
				Test book
			</Link>
		</div>
	)
}

export default Home

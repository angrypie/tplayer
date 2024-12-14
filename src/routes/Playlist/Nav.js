import React from 'react'
import { Link } from 'wouter'

export const Nav = () => (
	<div className='nav flex justify-end'>
		<Link href='/'>
			<div className='button flex justify-center items-center pointer bg-black dim'>
				<span className='b white'>to library</span>
			</div>
		</Link>
		<style jsx>{`
			.nav {
				height: 40px;
			}

			.button {
				height: 40px;
				width: 120px;
			}
		`}</style>
	</div>
)

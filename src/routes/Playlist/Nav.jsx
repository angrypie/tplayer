import React from 'react'
import { Link } from 'wouter'

export const Nav = () => (
	<div className='h-10 flex justify-end'>
		<Link href='/'>
			<div className='h-10 w-[120px] flex justify-center items-center cursor-pointer bg-black hover:opacity-90 transition-opacity'>
				<span className='font-bold text-white'>to library</span>
			</div>
		</Link>
	</div>
)

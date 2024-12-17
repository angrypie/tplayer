import React from 'react'
import { Route } from 'wouter'

import Home from './Home'
import Playlist from './Playlist'

export const LayoutRoute = ({ ...rest }) => (
	<div className='container mx-auto max-w-xl'>
		<Route path={'/'} exact component={Home} />
		<Route path={'/playlist/:ih'} exact component={Playlist} />
	</div>
)

export const createRoutes = () => <LayoutRoute />

export default createRoutes

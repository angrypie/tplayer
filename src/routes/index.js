import React from 'react'
import { Route } from 'wouter'

import Home from './Home'
import Playlist from './Playlist'

export const LayoutRoute = ({ ...rest }) => (
	<>
		<Route path={'/'} exact component={Home} />
		<Route path={'/Playlist'} exact component={Playlist} />
	</>
)

export const createRoutes = () => <LayoutRoute />

export default createRoutes

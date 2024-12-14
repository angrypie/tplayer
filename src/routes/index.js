import React from 'react'
import { Route } from 'wouter'

import Home from './Home'
import Playlist from './Playlist'

export const LayoutRoute = ({ ...rest }) => (
	<div className='container center mw6'>
		<Route path={'/'} exact component={Home} />
		<Route path={'/playlist/:ih'} exact component={Playlist} />
		<style>{`
				html, body {
					font-family: system-ui;
				}
			`}</style>
	</div>
)

export const createRoutes = () => <LayoutRoute />

export default createRoutes

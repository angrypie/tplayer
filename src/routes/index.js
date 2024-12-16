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
					overflow: hidden;
					height: 100%;
					overscroll-behavior: none;
				}
				.gap {
					gap: 0.5rem;
				}
				.gap-1 {
					gap: 1rem;
				}
				.gap-2 {
					gap: 2rem;
				}
				.gap-3 {
					gap: 3rem;
				}
			`}</style>
	</div>
)

export const createRoutes = () => <LayoutRoute />

export default createRoutes

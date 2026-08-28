import { Route } from 'wouter'

import Home from './Home'
import Playlist from './Playlist'

export const LayoutRoute = () => (
	<div className='container mx-auto max-w-xl'>
		<Route component={Home} exact path={'/'} />
		<Route component={Playlist} exact path={'/playlist/:ih'} />
	</div>
)

const createRoutes = () => <LayoutRoute />

export default createRoutes

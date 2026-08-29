import { Route } from 'wouter'

import Home from './Home'
import Playlist from './Playlist'
import Settings from './Settings'

export const LayoutRoute = () => (
	<div className='container mx-auto max-w-xl'>
		<Route component={Home} exact path={'/'} />
		<Route component={Playlist} exact path={'/playlist/:ih'} />
		<Route component={Settings} exact path={'/settings'} />
	</div>
)

const createRoutes = () => <LayoutRoute />

export default createRoutes

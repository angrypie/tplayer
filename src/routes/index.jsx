import { Route } from 'wouter'

import Home from './Home'
import Playlist from './Playlist'
import Settings from './Settings'

export const LayoutRoute = () => (
	<div className='mx-auto h-full w-full max-w-2xl border-border/60 border-x bg-background/60 shadow-2xl shadow-primary/5'>
		<Route component={Home} exact path={'/'} />
		<Route component={Playlist} exact path={'/playlist/:ih'} />
		<Route component={Settings} exact path={'/settings'} />
	</div>
)

const createRoutes = () => <LayoutRoute />

export default createRoutes

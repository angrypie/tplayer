import { createRoot } from 'react-dom/client'
import App from './App'
import Routes from './routes'
import './index.css'
import { ThemeProvider } from './components/theme-provider'

const routes = Routes()

const rootElement = document.getElementById('root')

if (!rootElement) {
	throw new Error('Root element was not found')
}

const root = createRoot(rootElement)
root.render(
	<ThemeProvider defaultTheme='light' storageKey='tplayer-ui-theme'>
		<App routes={routes} />
	</ThemeProvider>
)

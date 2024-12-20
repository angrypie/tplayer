import ReactDOM from 'react-dom/client';
import App from './App'
import Routes from './routes'
import './index.css'
import { ThemeProvider } from './components/theme-provider';



const routes = Routes()


const root = ReactDOM.createRoot(document.getElementById('root')!);
root.render(
	<ThemeProvider defaultTheme="light" storageKey="tplayer-ui-theme">
		<App routes={routes} />
	</ThemeProvider >
);


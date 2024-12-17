import ReactDOM from 'react-dom/client';
import App from './App'
import Routes from './routes'
import './index.css'



const routes = Routes()


const root = ReactDOM.createRoot(document.getElementById('root')!);
root.render(
	// <React.StrictMode>
	<App routes={routes} />
	// </React.StrictMode>
);


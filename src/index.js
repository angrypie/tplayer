import React from 'react'
import 'mobx-react-lite/batchingForReactDom'
import ReactDOM from 'react-dom'
import * as serviceWorker from './serviceWorker'

import 'tachyons'

import App from './containers/App'
import Routes from './routes'

const routes = Routes()

ReactDOM.render(<App routes={routes} />, document.getElementById('root'))

// If you want your app to work offline and load faster, you can change
// unregister() to register() below. Note this comes with some pitfalls.
// Learn more about service workers: http://bit.ly/CRA-PWA
serviceWorker.unregister()

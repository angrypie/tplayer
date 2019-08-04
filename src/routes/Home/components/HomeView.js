import React, { Component } from 'react'
import { Link } from 'wouter'

class HomeView extends Component {
	render() {
		return (
			<div className='container'>
				<Link href='/playlist'>to playlist</Link>
				<div className='box'></div>
				<style jsx>{`
					.box {
						padding: 1em;
					}
				`}</style>
			</div>
		)
	}
}

export default HomeView

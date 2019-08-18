import React from 'react'
import { observer } from 'mobx-react-lite'

export const BottomBar = observer(({ store }) => {
	//const [rate, setRate] = newState(store.rate)
	const { rate, changeRate } = store
	const nextRate = () => changeRate((r => (r > 2 ? 0.5 : r))(rate + 0.25))

	return (
		<>
			<div
				onClick={nextRate}
				className='b h2 w3 flex justify-center items-center'
			>
				{`x${rate}`}
			</div>
		</>
	)
})

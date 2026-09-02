import { observer } from 'mobx-react-lite'
import { BottomBar } from './BottomBar'
import { PlayButtons } from './PlayButtons'
import { DurationProgressLine } from './ProgressLines'

export const Player = observer(({ store }) => {
	const { playerStore } = store

	return (
		<div className='flex h-full flex-col justify-around py-2'>
			<DurationProgressLine store={playerStore} />
			<PlayButtons store={playerStore} />
			<div className='mx-4 flex h-8 items-center'>
				<BottomBar store={store} />
			</div>
		</div>
	)
})

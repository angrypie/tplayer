import { observer } from 'mobx-react-lite'
import { BottomBar } from './BottomBar'
import { LiveCaptions } from './LiveCaptions'
import { PlayButtons } from './PlayButtons'
import { DurationProgressLine } from './ProgressLines'

export const Player = observer(({ store }) => {
	const { playerStore } = store

	return (
		<div
			className={`flex h-full flex-col py-2 ${playerStore.liveCaptionsEnabled ? 'gap-1' : 'justify-around'}`}
		>
			{playerStore.liveCaptionsEnabled ? <LiveCaptions store={store} /> : null}
			<DurationProgressLine store={playerStore} />
			<PlayButtons store={playerStore} />
			<div className='mx-4 flex h-8 items-center'>
				<BottomBar store={store} />
			</div>
		</div>
	)
})

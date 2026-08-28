import { observer } from 'mobx-react-lite'
import { useCallback, useEffect, useRef, useState } from 'react'
import { maxVolume, numberOrLimit } from './store'

export const DurationProgressLine = observer(({ store }) => {
	const { audio } = store
	const [progress, setProgress] = useState(0)
	const [duration, setDuration] = useState(1)
	const seekTo = useCallback(
		(nextProgress) => store.seekTo(nextProgress),
		[store]
	)

	useEffect(() => {
		if (!audio) {
			return
		}
		const interval = setInterval(() => {
			setDuration(store.getDuration())
			setProgress(store.getProgress())
		}, 200)
		return () => clearInterval(interval)
	}, [audio, store])
	return (
		<div className='mx-4'>
			<ProgressLine
				displayMeasures={timeFormat}
				duration={duration}
				progress={progress}
				setProgress={seekTo}
			/>
		</div>
	)
})

export const VolumeProgressLine = observer(({ store }) => {
	const { changeVolume, setVolume, volume } = store
	const setProgress = useCallback(
		(value) => {
			const nextVolume = Math.round(value * 1e5) / 1e5
			changeVolume(nextVolume)
			setVolume(nextVolume)
		},
		[changeVolume, setVolume]
	)

	return (
		<div className='mx-8'>
			<ProgressLine
				duration={maxVolume}
				progress={volume}
				setProgress={setProgress}
			/>
		</div>
	)
})

const ProgressLine = ({ duration, progress, setProgress, displayMeasures }) => {
	const [controlled, setControlled] = useState(false)
	const [position, setPosition] = useState(progress)
	const progressRef = useRef(null)

	useEffect(() => {
		if (!controlled) {
			setPosition(progress)
		}
	}, [progress, controlled])

	//calc returns progress percent value based on duration
	//Use position instead progress to controll this value in component state
	const calc = (v) => Math.round((v * 10_000) / duration) / 100
	const d = calc(duration - position)
	const p = calc(position)

	const touchMove = (e) => {
		setControlled(true)
		const [touch] = e.targetTouches
		if (!touch) {
			return
		}
		const x = touch.clientX - progressRef.current.getBoundingClientRect().x
		const w = progressRef.current.offsetWidth
		setPosition(numberOrLimit((x / w) * duration, 0, duration))
	}

	const releaseControl = () => {
		setProgress(position)
		setTimeout(() => setControlled(false), 200)
	}

	const clickSetPosition = (e) => {
		const x = e.clientX - progressRef.current.getBoundingClientRect().x
		const w = progressRef.current.offsetWidth
		const nextPosition = numberOrLimit((x / w) * duration, 0, duration)
		setPosition(nextPosition)
		setProgress(nextPosition)
		setTimeout(() => setControlled(false), 200)
	}

	const handleKeyDown = (event) => {
		const step = duration / 100
		let nextPosition
		switch (event.key) {
			case 'ArrowLeft':
			case 'ArrowDown':
				nextPosition = position - step
				break
			case 'ArrowRight':
			case 'ArrowUp':
				nextPosition = position + step
				break
			case 'Home':
				nextPosition = 0
				break
			case 'End':
				nextPosition = duration
				break
			default:
				return
		}
		event.preventDefault()
		const limitedPosition = numberOrLimit(nextPosition, 0, duration)
		setPosition(limitedPosition)
		setProgress(limitedPosition)
	}

	return (
		<div
			aria-orientation='horizontal'
			aria-valuemax={duration}
			aria-valuemin={0}
			aria-valuenow={position}
			className='flex h-8 w-full cursor-pointer flex-col justify-center'
			onClick={clickSetPosition}
			onKeyDown={handleKeyDown}
			onTouchEnd={releaseControl}
			onTouchMove={touchMove}
			ref={progressRef}
			role='slider'
			tabIndex={0}
		>
			<div className='flex h-4 items-center'>
				<div className='h-[6px] bg-black' style={{ width: `${p}%` }} />
				<div className='h-[1px] bg-black' style={{ width: `${d}%` }} />
			</div>

			{typeof displayMeasures === 'function' ? (
				<div className='flex justify-between'>
					<div className='font-medium text-[13px] opacity-50'>
						{displayMeasures(position)}
					</div>
					<div className='font-medium text-[13px] opacity-50'>
						-{displayMeasures(duration - position)}
					</div>
				</div>
			) : null}
		</div>
	)
}

export function timeFormat(time) {
	const numericTime = Number(time)
	const totalSeconds = Number.isFinite(numericTime)
		? Math.trunc(numericTime)
		: 0
	// Hours, minutes and seconds
	const hrs = Math.trunc(totalSeconds / 3600)
	const mins = Math.trunc((totalSeconds % 3600) / 60)
	const secs = totalSeconds % 60
	const secondsLabel = String(secs).padStart(2, '0')
	if (hrs > 0) {
		return `${hrs}:${String(mins).padStart(2, '0')}:${secondsLabel}`
	}
	return `${mins}:${secondsLabel}`
}

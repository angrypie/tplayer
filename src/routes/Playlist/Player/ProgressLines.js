import React, { useState, useRef, useEffect } from 'react'
import { numberOrLimit, maxVolume } from './store'
import { observer } from 'mobx-react-lite'

export const DurationProgressLine = observer(({ store }) => {
	const { audio } = store
	const [progress, setProgress] = useState(0)
	const [duration, setDuration] = useState(1)

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
				progress={progress}
				duration={duration}
				setProgress={p => store.seekTo(p)}
				displayMeasures={m => timeFormat(m)}
			/>
		</div>
	)
})

export const VolumeProgressLine = observer(({ store }) => {
	const { changeVolume, setVolume, volume } = store
	const setProgress = v => {
		const volume = Math.round(v * 1e5) / 1e5
		changeVolume(volume)
		setVolume(volume)
	}

	return (
		<div className='mx-8'>
			<ProgressLine
				progress={volume}
				duration={maxVolume}
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
	const calc = v => Math.round((v * 10000) / duration) / 100
	const d = calc(duration - position)
	const p = calc(position)

	const touchMove = e => {
		setControlled(true)
		const touch = e.targetTouches[0]
		const x = touch.clientX - progressRef.current.getBoundingClientRect().x
		const w = progressRef.current.offsetWidth
		setPosition(numberOrLimit((x / w) * duration, 0, duration))
	}

	const releaseControll = () => {
		setProgress(position)
		setTimeout(() => setControlled(false), 200)
	}

	const clickSetPosition = e => {
		const x = e.clientX - progressRef.current.getBoundingClientRect().x
		const w = progressRef.current.offsetWidth
		const position = numberOrLimit((x / w) * duration, 0, duration)
		setPosition(position)
		setProgress(position)
		setTimeout(() => setControlled(false), 200)
	}

	return (
		<div
			className='h-8 w-full flex flex-col justify-center cursor-pointer'
			ref={progressRef}
			onTouchMove={touchMove}
			onTouchEnd={releaseControll}
			onClick={clickSetPosition}
		>
			<div className='flex items-center h-4'>
				<div style={{ width: `${p}%` }} className='bg-black h-[6px]'></div>
				<div style={{ width: `${d}%` }} className='bg-black h-[1px]'></div>
			</div>

			{
				typeof displayMeasures !== 'function' ? null : (
					<div className='flex justify-between'>
						<div className='text-[13px] opacity-50 font-medium'>{displayMeasures(position)}</div>
						<div className='text-[13px] opacity-50 font-medium'>-{displayMeasures(duration - position)}</div>
					</div>
				)
			}
		</div >
	)
}

export function timeFormat(time) {
	time = ~~time
	// Hours, minutes and seconds
	const hrs = ~~(time / 3600)
	const mins = ~~((time % 3600) / 60)
	const secs = ~~time % 60

	let ret = ''

	if (hrs > 0) {
		ret += '' + hrs + ':' + (mins < 10 ? '0' : '')
	}

	ret += '' + mins + ':' + (secs < 10 ? '0' : '')
	ret += '' + secs
	return ret
}

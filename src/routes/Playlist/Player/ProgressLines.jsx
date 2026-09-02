import { observer } from 'mobx-react-lite'
import { useCallback, useEffect, useRef, useState } from 'react'
import { maxVolume, numberOrLimit } from './store'

export const DurationProgressLine = observer(({ store }) => {
	const { audio } = store
	const [progress, setProgress] = useState(0)
	const [duration, setDuration] = useState(1)
	const seekTo = useCallback(
		(nextProgress) => {
			setProgress(nextProgress)
			store.seekTo(nextProgress)
		},
		[store]
	)

	useEffect(() => {
		if (!audio) {
			setDuration(1)
			setProgress(0)
			return
		}
		const updateProgress = () => {
			setDuration(store.getDuration())
			setProgress(store.getProgress())
		}
		updateProgress()
		const interval = setInterval(() => {
			updateProgress()
		}, 200)
		return () => clearInterval(interval)
	}, [audio, store])
	return (
		<div className='mx-4'>
			<ProgressLine
				ariaLabel='Playback position'
				displayMeasures={timeFormat}
				duration={duration}
				progress={progress}
				relativeScrub
				setProgress={seekTo}
				showPreview
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
				ariaLabel='Volume'
				duration={maxVolume}
				progress={volume}
				setProgress={setProgress}
			/>
		</div>
	)
})

const ProgressLine = ({
	ariaLabel,
	displayMeasures,
	duration,
	progress,
	relativeScrub = false,
	setProgress,
	showPreview = false,
}) => {
	const safeDuration = Number.isFinite(duration) && duration > 0 ? duration : 1
	const [isDragging, setIsDragging] = useState(false)
	const [position, setPosition] = useState(() =>
		numberOrLimit(progress, 0, safeDuration)
	)
	const activePointerIdRef = useRef(null)
	const boundsRef = useRef({ left: 0, width: 1 })
	const frameRef = useRef(null)
	const gestureOriginRef = useRef({
		clientX: 0,
		movementStarted: !relativeScrub,
		position: 0,
		relative: relativeScrub,
	})
	const pendingPositionRef = useRef(position)
	const progressRef = useRef(null)

	useEffect(() => {
		if (!isDragging) {
			const nextPosition = numberOrLimit(progress, 0, safeDuration)
			pendingPositionRef.current = nextPosition
			setPosition(nextPosition)
		}
	}, [isDragging, progress, safeDuration])

	useEffect(
		() => () => {
			if (frameRef.current !== null) {
				cancelAnimationFrame(frameRef.current)
			}
		},
		[]
	)

	const positionFromPointer = (clientX) => {
		const { left, width } = boundsRef.current
		const gestureOrigin = gestureOriginRef.current
		if (gestureOrigin.relative && !gestureOrigin.movementStarted) {
			return gestureOrigin.position
		}
		const nextPosition = gestureOrigin.relative
			? gestureOrigin.position +
				((clientX - gestureOrigin.clientX) / width) * safeDuration
			: ((clientX - left) / width) * safeDuration
		return numberOrLimit(nextPosition, 0, safeDuration)
	}

	const queuePosition = (nextPosition) => {
		pendingPositionRef.current = nextPosition
		if (frameRef.current !== null) {
			return
		}
		frameRef.current = requestAnimationFrame(() => {
			frameRef.current = null
			setPosition(pendingPositionRef.current)
		})
	}

	const handlePointerDown = (event) => {
		if (
			!event.isPrimary ||
			(event.pointerType === 'mouse' && event.button !== 0)
		) {
			return
		}
		const bounds = event.currentTarget.getBoundingClientRect()
		boundsRef.current = {
			left: bounds.left,
			width: Math.max(bounds.width, 1),
		}
		const startsFromCurrentPosition =
			relativeScrub && event.pointerType !== 'mouse'
		gestureOriginRef.current = {
			clientX: event.clientX,
			movementStarted: !startsFromCurrentPosition,
			position: numberOrLimit(pendingPositionRef.current, 0, safeDuration),
			relative: startsFromCurrentPosition,
		}
		activePointerIdRef.current = event.pointerId
		event.currentTarget.setPointerCapture(event.pointerId)
		const nextPosition = positionFromPointer(event.clientX)
		pendingPositionRef.current = nextPosition
		setPosition(nextPosition)
		setIsDragging(true)
		event.preventDefault()
	}

	const handlePointerMove = (event) => {
		if (activePointerIdRef.current !== event.pointerId) {
			return
		}
		const gestureOrigin = gestureOriginRef.current
		if (gestureOrigin.relative && !gestureOrigin.movementStarted) {
			gestureOrigin.clientX = event.clientX
			gestureOrigin.movementStarted = true
			return
		}
		queuePosition(positionFromPointer(event.clientX))
	}

	const handlePointerUp = (event) => {
		if (activePointerIdRef.current !== event.pointerId) {
			return
		}
		const nextPosition = positionFromPointer(event.clientX)
		if (frameRef.current !== null) {
			cancelAnimationFrame(frameRef.current)
			frameRef.current = null
		}
		pendingPositionRef.current = nextPosition
		setPosition(nextPosition)
		setProgress(nextPosition)
		activePointerIdRef.current = null
		setIsDragging(false)
		if (event.currentTarget.hasPointerCapture(event.pointerId)) {
			event.currentTarget.releasePointerCapture(event.pointerId)
		}
	}

	const handlePointerCancel = (event) => {
		if (activePointerIdRef.current !== event.pointerId) {
			return
		}
		if (frameRef.current !== null) {
			cancelAnimationFrame(frameRef.current)
			frameRef.current = null
		}
		activePointerIdRef.current = null
		setIsDragging(false)
		const nextPosition = numberOrLimit(progress, 0, safeDuration)
		pendingPositionRef.current = nextPosition
		setPosition(nextPosition)
	}

	const handleKeyDown = (event) => {
		const step = safeDuration / 100
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
				nextPosition = safeDuration
				break
			default:
				return
		}
		event.preventDefault()
		const limitedPosition = numberOrLimit(nextPosition, 0, safeDuration)
		pendingPositionRef.current = limitedPosition
		setPosition(limitedPosition)
		setProgress(limitedPosition)
	}

	const positionPercentage = (position / safeDuration) * 100
	const formattedPosition =
		typeof displayMeasures === 'function'
			? displayMeasures(position)
			: undefined

	return (
		<div
			aria-label={ariaLabel}
			aria-orientation='horizontal'
			aria-valuemax={safeDuration}
			aria-valuemin={0}
			aria-valuenow={position}
			aria-valuetext={formattedPosition}
			className='relative flex h-12 w-full cursor-pointer touch-none select-none flex-col justify-center rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2'
			onKeyDown={handleKeyDown}
			onPointerCancel={handlePointerCancel}
			onPointerDown={handlePointerDown}
			onPointerMove={handlePointerMove}
			onPointerUp={handlePointerUp}
			ref={progressRef}
			role='slider'
			tabIndex={0}
		>
			{showPreview && isDragging && formattedPosition ? (
				<output
					aria-hidden='true'
					className='pointer-events-none absolute bottom-[calc(50%+0.75rem)] z-10 -translate-x-1/2 rounded-md bg-foreground px-2 py-1 font-medium text-background text-xs tabular-nums shadow-md'
					data-testid='seek-preview'
					style={{
						left: `clamp(1.75rem, ${positionPercentage}%, calc(100% - 1.75rem))`,
					}}
				>
					{formattedPosition}
				</output>
			) : null}
			<div className='pointer-events-none relative flex h-4 w-full items-center'>
				<div className='absolute h-1.5 w-full rounded-full bg-muted' />
				<div
					className='absolute h-1.5 w-full origin-left will-change-transform'
					style={{ transform: `scaleX(${positionPercentage / 100})` }}
				>
					<div
						className={`h-full w-full rounded-full bg-primary transition-transform duration-150 ease-out ${isDragging ? 'scale-y-[1.3]' : ''}`}
					/>
				</div>
			</div>

			{typeof displayMeasures === 'function' ? (
				<div
					className={`pointer-events-none absolute top-[calc(50%+0.65rem)] flex w-full justify-between transition-colors duration-150 ${isDragging ? 'text-foreground' : 'text-muted-foreground'}`}
				>
					<div className='font-medium text-[13px] tabular-nums'>
						{formattedPosition}
					</div>
					<div className='font-medium text-[13px] tabular-nums'>
						-{displayMeasures(safeDuration - position)}
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

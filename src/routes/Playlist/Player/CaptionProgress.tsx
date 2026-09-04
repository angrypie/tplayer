import type { TranscriptionState } from '~/captions/api'
import { Progress } from '~/components/ui/progress'

const MAXIMUM_PERCENTAGE = 100
const MILLISECONDS_PER_SECOND = 1000
const SECONDS_PER_MINUTE = 60
const MINUTES_PER_HOUR = 60

interface CaptionProgressProps {
	isLive?: boolean
	processedMilliseconds: number
	queueBlockedByCleanup?: boolean
	state?: Extract<TranscriptionState, 'preparing' | 'queued' | 'transcribing'>
	totalMilliseconds?: number
}

export interface CaptionProgressModel {
	detail: string
	percentage?: number
	percentageLabel?: string
	valueText: string
}

const formatMilliseconds = (milliseconds: number): string => {
	const totalSeconds = Math.floor(milliseconds / MILLISECONDS_PER_SECOND)
	const hours = Math.floor(
		totalSeconds / (SECONDS_PER_MINUTE * MINUTES_PER_HOUR)
	)
	const minutes = Math.floor(
		(totalSeconds % (SECONDS_PER_MINUTE * MINUTES_PER_HOUR)) /
			SECONDS_PER_MINUTE
	)
	const seconds = totalSeconds % SECONDS_PER_MINUTE
	const secondsLabel = String(seconds).padStart(2, '0')
	if (hours > 0) {
		return `${hours}:${String(minutes).padStart(2, '0')}:${secondsLabel}`
	}
	return `${minutes}:${secondsLabel}`
}

const positiveFiniteNumber = (value: number | undefined): number | undefined =>
	typeof value === 'number' && Number.isFinite(value) && value > 0
		? value
		: undefined

export const resolveCaptionProgressTotal = (
	state: TranscriptionState | undefined,
	reportedMilliseconds: number | undefined,
	playerLoaded: boolean,
	playerDurationSeconds: number | undefined
): number | undefined => {
	if (state !== 'transcribing') {
		return undefined
	}
	const reportedTotal = positiveFiniteNumber(reportedMilliseconds)
	if (reportedTotal !== undefined) {
		return reportedTotal
	}
	if (!playerLoaded) {
		return undefined
	}
	const durationSeconds = positiveFiniteNumber(playerDurationSeconds)
	return durationSeconds === undefined
		? undefined
		: durationSeconds * MILLISECONDS_PER_SECOND
}

export const captionProgressModel = (
	processedMilliseconds: number,
	totalMilliseconds: number | undefined
): CaptionProgressModel => {
	const total = positiveFiniteNumber(totalMilliseconds)
	if (total === undefined) {
		const finiteProcessed = Number.isFinite(processedMilliseconds)
			? Math.max(0, processedMilliseconds)
			: 0
		if (finiteProcessed > 0) {
			const processedLabel = formatMilliseconds(finiteProcessed)
			return {
				detail: `${processedLabel} transcribed`,
				valueText: `${processedLabel} transcribed; the total duration is not known yet.`,
			}
		}
		return {
			detail: 'Progress pending…',
			valueText:
				'Transcription is in progress; the chapter duration is not known yet.',
		}
	}
	const finiteProcessed = Number.isFinite(processedMilliseconds)
		? processedMilliseconds
		: 0
	const processed = Math.min(total, Math.max(0, finiteProcessed))
	const rawPercentage = (processed / total) * MAXIMUM_PERCENTAGE
	const roundedPercentage = Math.round(rawPercentage * 10) / 10
	let percentage = roundedPercentage
	if (processed > 0 && roundedPercentage === 0) {
		percentage = 0.1
	} else if (processed < total && roundedPercentage >= MAXIMUM_PERCENTAGE) {
		percentage = 99.9
	}
	const percentageLabel =
		rawPercentage > 0 && rawPercentage < 0.1 ? '<0.1%' : `${percentage}%`
	const detail = `${formatMilliseconds(processed)} of ${formatMilliseconds(total)}`
	return {
		detail,
		percentage,
		percentageLabel,
		valueText: `${percentageLabel} complete, ${detail}`,
	}
}

export const CaptionProgress = ({
	isLive = true,
	processedMilliseconds,
	queueBlockedByCleanup = false,
	state = 'transcribing',
	totalMilliseconds,
}: CaptionProgressProps) => {
	const model = captionProgressModel(processedMilliseconds, totalMilliseconds)
	const { percentage } = model
	const determinate = percentage !== undefined
	let { detail, valueText: liveValueText } = model
	let leadingLabel = 'Last reported'
	if (determinate) {
		leadingLabel = model.percentageLabel ?? '0%'
	} else if (isLive) {
		if (state === 'queued') {
			if (queueBlockedByCleanup) {
				leadingLabel = 'Queue paused'
				detail = 'Waiting for cleanup'
				liveValueText =
					'Waiting for the previous chapter to release local resources.'
			} else {
				leadingLabel = 'Waiting'
				detail = 'Queued for transcription'
				liveValueText = 'Waiting for transcription to start.'
			}
		} else if (state === 'preparing') {
			leadingLabel = 'Preparing'
			detail = 'Preparing local audio'
			liveValueText = 'Preparing local audio for transcription.'
		} else {
			leadingLabel = 'In progress'
		}
	} else if (state === 'queued') {
		detail = 'Queued when last checked'
		liveValueText = 'The chapter was queued when status was last available.'
	} else if (state === 'preparing') {
		detail = 'Preparing when last checked'
		liveValueText = 'The chapter was preparing when status was last available.'
	}
	const accessibleValue = isLive
		? liveValueText
		: `Last reported: ${liveValueText}`
	const showActivity = !determinate && isLive && state !== 'queued'
	return (
		<div
			className='w-full space-y-1.5'
			data-caption-progress={determinate ? 'determinate' : 'indeterminate'}
			data-caption-stage={state}
		>
			<div className='flex min-h-5 items-center justify-between gap-3 text-muted-foreground text-xs tabular-nums'>
				<span className='font-medium text-foreground/80'>{leadingLabel}</span>
				<span>{detail}</span>
			</div>
			<div className='relative'>
				<Progress
					aria-label={
						isLive
							? 'Transcription progress'
							: 'Last reported transcription progress'
					}
					aria-valuetext={accessibleValue}
					className='h-1.5'
					value={model.percentage}
				/>
				{showActivity ? (
					<span
						aria-hidden='true'
						className='pointer-events-none absolute inset-y-0 left-1/3 w-1/3 animate-pulse rounded-full bg-primary/70 motion-reduce:animate-none'
					/>
				) : null}
			</div>
		</div>
	)
}

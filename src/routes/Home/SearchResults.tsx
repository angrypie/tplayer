import { BookOpen, ExternalLink, SearchX } from 'lucide-react'
import { Button } from '~/components/ui/button'
import type {
	AudiobookSearchResult,
	SearchProviderReport,
} from '~/search/types'
import { safeExternalUrl } from '~/search/url'
import {
	type AudiobookSearchController,
	searchResultKey,
} from './useAudiobookSearch'

interface SearchResultsProps {
	controller: AudiobookSearchController
}

interface ResultCardProps {
	isDisabled: boolean
	isOpening: boolean
	onOpen: (result: AudiobookSearchResult) => Promise<void>
	providerLabel: string
	result: AudiobookSearchResult
}

interface ResultGroupProps {
	description: string
	onOpen: (result: AudiobookSearchResult) => Promise<void>
	openingResultKey: string | null
	providerLabels: ReadonlyMap<string, string>
	results: AudiobookSearchResult[]
	title: string
}

const formatBytes = (bytes: number): string => {
	if (bytes < 1024) {
		return `${bytes} B`
	}
	const units = ['KB', 'MB', 'GB', 'TB']
	let size = bytes / 1024
	let unitIndex = 0
	while (size >= 1024 && unitIndex < units.length - 1) {
		size /= 1024
		unitIndex += 1
	}
	return `${size >= 10 ? size.toFixed(0) : size.toFixed(1)} ${units[unitIndex]}`
}

const formatDuration = (seconds: number): string => {
	const totalMinutes = Math.round(seconds / 60)
	const hours = Math.floor(totalMinutes / 60)
	const minutes = totalMinutes % 60
	if (hours === 0) {
		return `${minutes} min`
	}
	return minutes === 0 ? `${hours} hr` : `${hours} hr ${minutes} min`
}

const resultMetadata = (result: AudiobookSearchResult): string[] => {
	const values: string[] = []
	if (result.language) {
		values.push(result.language)
	}
	if (result.durationSeconds !== undefined) {
		values.push(formatDuration(result.durationSeconds))
	}
	if (result.format) {
		values.push(result.format)
	}
	if (result.sizeBytes !== undefined) {
		values.push(formatBytes(result.sizeBytes))
	}
	if (result.publishedAt) {
		values.push(result.publishedAt)
	}
	if (result.downloads !== undefined) {
		values.push(`${result.downloads.toLocaleString()} downloads`)
	}
	return values
}

const ResultCard = ({
	isDisabled,
	isOpening,
	onOpen,
	providerLabel,
	result,
}: ResultCardProps) => {
	const coverUrl = safeExternalUrl(result.coverUrl)
	const detailUrl = safeExternalUrl(result.detailUrl)
	const metadata = resultMetadata(result)

	const handleOpen = async (): Promise<void> => {
		await onOpen(result)
	}

	return (
		<li className='rounded-lg border border-border bg-card p-3 shadow-sm'>
			<div className='flex gap-3'>
				<div className='flex h-24 w-20 shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted'>
					{coverUrl ? (
						<img
							alt=''
							className='h-full w-full object-cover'
							height={96}
							loading='lazy'
							referrerPolicy='no-referrer'
							src={coverUrl}
							width={80}
						/>
					) : (
						<BookOpen
							aria-hidden='true'
							className='h-7 w-7 text-muted-foreground'
						/>
					)}
				</div>
				<div className='min-w-0 flex-1 space-y-2'>
					<div>
						<div className='mb-1 inline-flex rounded-full bg-secondary px-2 py-0.5 font-medium text-secondary-foreground text-xs'>
							{providerLabel}
						</div>
						<h3 className='font-semibold leading-tight'>{result.title}</h3>
						<p className='text-muted-foreground text-sm'>
							{result.authors.length > 0
								? result.authors.join(', ')
								: 'Unknown author'}
						</p>
					</div>
					{metadata.length > 0 ? (
						<p className='text-muted-foreground text-xs'>
							{metadata.join(' · ')}
						</p>
					) : null}
					{result.description ? (
						<p className='line-clamp-2 text-muted-foreground text-sm'>
							{result.description}
						</p>
					) : null}
					<div className='flex flex-wrap items-center gap-2'>
						<Button
							aria-label={`Open ${result.title} from ${providerLabel}`}
							disabled={isDisabled}
							onClick={handleOpen}
							size='sm'
							type='button'
						>
							{isOpening ? 'Opening…' : 'Open audiobook'}
						</Button>
						{detailUrl ? (
							<Button asChild size='sm' variant='ghost'>
								<a href={detailUrl} rel='noopener noreferrer' target='_blank'>
									Details
									<ExternalLink aria-hidden='true' className='h-3.5 w-3.5' />
								</a>
							</Button>
						) : null}
					</div>
				</div>
			</div>
		</li>
	)
}

const ResultGroup = ({
	description,
	onOpen,
	openingResultKey,
	providerLabels,
	results,
	title,
}: ResultGroupProps) => {
	if (results.length === 0) {
		return null
	}
	return (
		<section className='space-y-3'>
			<div>
				<h2 className='font-bold text-xl'>{title}</h2>
				<p className='text-muted-foreground text-sm'>{description}</p>
			</div>
			<ul className='space-y-3'>
				{results.map((result) => {
					const key = searchResultKey(result)
					return (
						<ResultCard
							isDisabled={openingResultKey !== null}
							isOpening={openingResultKey === key}
							key={key}
							onOpen={onOpen}
							providerLabel={
								providerLabels.get(result.providerId) ?? result.providerId
							}
							result={result}
						/>
					)
				})}
			</ul>
		</section>
	)
}

const ProviderFailures = ({ reports }: { reports: SearchProviderReport[] }) => {
	const failures = reports.filter((report) => report.state === 'error')
	if (failures.length === 0) {
		return null
	}
	return (
		<div
			className='rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm'
			role='status'
		>
			<p className='font-medium'>Some sources could not be searched.</p>
			<ul className='mt-1 list-disc pl-5 text-muted-foreground'>
				{failures.map((report) => (
					<li key={report.id}>
						{report.label}: {report.error ?? 'Search failed'}
					</li>
				))}
			</ul>
		</div>
	)
}

export const SearchResults = ({ controller }: SearchResultsProps) => {
	const trackerIds = new Set(controller.trackerProviderIds)
	const freeResults = controller.results.filter(
		(result) => !trackerIds.has(result.providerId)
	)
	const trackerResults = controller.results.filter((result) =>
		trackerIds.has(result.providerId)
	)
	const providerLabels = new Map(
		controller.providerReports.map((report) => [report.id, report.label])
	)
	const hasSuccessfulProvider = controller.providerReports.some(
		(report) => report.state === 'ok'
	)

	return (
		<div
			aria-busy={controller.status === 'searching'}
			aria-live='polite'
			className='space-y-5 px-3 pb-6'
		>
			<div className='flex items-start justify-between gap-3'>
				<div className='min-w-0'>
					<h1 className='font-bold text-2xl'>Search results</h1>
					{controller.activeQuery ? (
						<p className='truncate text-muted-foreground text-sm'>
							For “{controller.activeQuery}”
						</p>
					) : null}
				</div>
				<Button
					disabled={controller.openingResultKey !== null}
					onClick={controller.clearSearch}
					size='sm'
					type='button'
					variant='outline'
				>
					Clear
				</Button>
			</div>

			{controller.status === 'searching' ? (
				<p className='py-8 text-center text-muted-foreground' role='status'>
					Searching free audiobook sources…
				</p>
			) : null}

			<ProviderFailures reports={controller.providerReports} />

			{controller.status === 'success' &&
			hasSuccessfulProvider &&
			controller.results.length === 0 ? (
				<div className='flex flex-col items-center gap-2 py-10 text-center text-muted-foreground'>
					<SearchX aria-hidden='true' className='h-8 w-8' />
					<p>No audiobooks were found. Try another title or author.</p>
				</div>
			) : null}

			{controller.status === 'success' &&
			!hasSuccessfulProvider &&
			controller.providerReports.length > 0 ? (
				<div className='flex flex-col items-center gap-2 py-10 text-center text-muted-foreground'>
					<SearchX aria-hidden='true' className='h-8 w-8' />
					<p>No search source is currently available. Try again shortly.</p>
				</div>
			) : null}

			<ResultGroup
				description='Public-domain and freely available catalogues.'
				onOpen={controller.openResult}
				openingResultKey={controller.openingResultKey}
				providerLabels={providerLabels}
				results={freeResults}
				title='Free audiobooks'
			/>
			<ResultGroup
				description='Results from tracker sources you enabled in Settings.'
				onOpen={controller.openResult}
				openingResultKey={controller.openingResultKey}
				providerLabels={providerLabels}
				results={trackerResults}
				title='Optional tracker results'
			/>
		</div>
	)
}

import {
	BookOpen,
	ExternalLink,
	LoaderCircle,
	SearchX,
	TriangleAlert,
} from 'lucide-react'
import { ContentUseNotice } from '~/components/ContentUseNotice'
import { SectionHeading } from '~/components/layout/Page'
import { Alert, AlertDescription, AlertTitle } from '~/components/ui/alert'
import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import { Card } from '~/components/ui/card'
import { EmptyState } from '~/components/ui/empty-state'
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
	hasContentUseNotice?: boolean
	isInteractionBlocked: boolean
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
	const rightsUrl = safeExternalUrl(result.rightsUrl)
	const metadata = resultMetadata(result)

	const handleOpen = async (): Promise<void> => {
		await onOpen(result)
	}

	return (
		<li>
			<Card className='p-3 transition-[border-color,box-shadow] hover:border-primary/25 hover:shadow-md'>
				<div className='flex gap-3'>
					<div className='flex h-24 w-20 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted'>
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
							<Badge className='mb-1'>{providerLabel}</Badge>
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
							{rightsUrl ? (
								<Button asChild size='sm' variant='ghost'>
									<a href={rightsUrl} rel='noopener noreferrer' target='_blank'>
										Rights information
										<ExternalLink aria-hidden='true' className='h-3.5 w-3.5' />
									</a>
								</Button>
							) : null}
						</div>
					</div>
				</div>
			</Card>
		</li>
	)
}

const ResultGroup = ({
	description,
	hasContentUseNotice = false,
	isInteractionBlocked,
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
			<SectionHeading description={description} title={title} />
			{hasContentUseNotice ? (
				<ContentUseNotice compact includeThirdParty />
			) : null}
			<ul className='space-y-3'>
				{results.map((result) => {
					const key = searchResultKey(result)
					return (
						<ResultCard
							isDisabled={isInteractionBlocked || openingResultKey !== null}
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
		<Alert role='status' variant='warning'>
			<TriangleAlert aria-hidden='true' />
			<div>
				<AlertTitle>Some sources could not be searched.</AlertTitle>
				<AlertDescription>
					<ul className='list-disc pl-5'>
						{failures.map((report) => (
							<li key={report.id}>
								{report.label}: {report.error ?? 'Search failed'}
							</li>
						))}
					</ul>
				</AlertDescription>
			</div>
		</Alert>
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
			className='space-y-6'
		>
			<SectionHeading
				action={
					<Button
						disabled={
							controller.openingResultKey !== null ||
							controller.contentUseConfirmation !== null
						}
						onClick={controller.clearSearch}
						size='sm'
						type='button'
						variant='outline'
					>
						Clear
					</Button>
				}
				description={
					controller.activeQuery ? `For “${controller.activeQuery}”` : undefined
				}
				title='Search results'
				titleAs='h1'
			/>

			{controller.status === 'searching' ? (
				<div
					className='flex items-center justify-center gap-2 py-8 text-muted-foreground'
					role='status'
				>
					<LoaderCircle
						aria-hidden='true'
						className='size-4 animate-spin motion-reduce:animate-none'
					/>
					Searching public-domain and rights-labelled sources…
				</div>
			) : null}

			<ProviderFailures reports={controller.providerReports} />

			{controller.status === 'success' &&
			hasSuccessfulProvider &&
			controller.results.length === 0 ? (
				<EmptyState
					description='Try another title or author.'
					icon={SearchX}
					title='No audiobooks were found'
				/>
			) : null}

			{controller.status === 'success' &&
			!hasSuccessfulProvider &&
			controller.providerReports.length > 0 ? (
				<EmptyState
					description='Try again shortly.'
					icon={SearchX}
					title='No search source is currently available'
				/>
			) : null}

			<ResultGroup
				description='LibriVox public-domain recordings and Internet Archive items with source-supplied rights information. Verify each item where you live.'
				isInteractionBlocked={controller.contentUseConfirmation !== null}
				onOpen={controller.openResult}
				openingResultKey={controller.openingResultKey}
				providerLabels={providerLabels}
				results={freeResults}
				title='Public-domain and rights-labelled audiobooks'
			/>
			<ResultGroup
				description='Rights status is unverified. Open only material you are authorized to download and share.'
				hasContentUseNotice
				isInteractionBlocked={controller.contentUseConfirmation !== null}
				onOpen={controller.openResult}
				openingResultKey={controller.openingResultKey}
				providerLabels={providerLabels}
				results={trackerResults}
				title='Unverified third-party results'
			/>
		</div>
	)
}

import {
	ChevronDown,
	CircleCheck,
	CircleX,
	CloudDownload,
	CloudOff,
	LoaderCircle,
	RefreshCw,
	ShieldAlert,
} from 'lucide-react'
import { Button } from '~/components/ui/button'
import type { TorrentServerStatus as TorrentServerStatusDto } from './api'
import { formatBytes } from './utils'

export type TorrentServerPhase =
	| 'checking'
	| 'connection-error'
	| 'metadata-error'
	| 'not-found'
	| 'registration-error'
	| 'registering'
	| 'registered'

interface TorrentServerStatusProps {
	error?: string | null
	onAction: () => Promise<void> | void
	onRetry: () => void
	phase: TorrentServerPhase
	serverAccessAllowed: boolean
	status: TorrentServerStatusDto | null
}

interface StatusCopy {
	description: string
	title: string
}

const percentage = (status: TorrentServerStatusDto): number => {
	if (status.totalBytes > 0) {
		return Math.min(
			100,
			Math.max(0, (status.downloadedBytes / status.totalBytes) * 100)
		)
	}
	const normalizedProgress = status.progress <= 1 ? status.progress * 100 : 0
	return Math.min(100, Math.max(0, normalizedProgress))
}

const statusCopy = (
	phase: TorrentServerPhase,
	status: TorrentServerStatusDto | null,
	error?: string | null
): StatusCopy => {
	if (phase === 'not-found') {
		return {
			description:
				'This source has not been added. Start it only if you are authorized to download and share it.',
			title: 'This torrent is not on the server',
		}
	}
	if (phase === 'registering') {
		return {
			description:
				'The server is creating a background download job. You can leave this page after it has been added.',
			title: 'Adding torrent to the server…',
		}
	}
	if (phase === 'registration-error') {
		return {
			description:
				error ?? 'The server could not create the background download job.',
			title: 'Unable to add torrent',
		}
	}
	if (phase === 'metadata-error') {
		return {
			description:
				error ??
				'The book details are ready on the server, but this page could not load them.',
			title: 'Unable to load book details',
		}
	}
	if (phase === 'connection-error') {
		return {
			description:
				error ??
				'The server status could not be reached. The download may still be running.',
			title: 'Unable to check server status',
		}
	}
	if (!(phase === 'registered' && status)) {
		return {
			description:
				'Checking whether this torrent is already running on the server.',
			title: 'Checking server status…',
		}
	}
	if (status.state === 'failed') {
		return {
			description:
				status.error ??
				'The server could not continue this background download.',
			title: 'Server download failed',
		}
	}
	if (status.state === 'completed') {
		return {
			description:
				'The server finished downloading this torrent and can keep serving its files.',
			title: 'Downloaded on server',
		}
	}
	if (status.state === 'downloading') {
		return {
			description:
				'The server keeps downloading in the background. You can leave this page and return later.',
			title: 'Downloading on the server',
		}
	}
	if (status.state === 'fetching_metadata') {
		return {
			description:
				'The server is finding the book details. Its background job continues if you leave this page.',
			title: 'Finding book details…',
		}
	}
	return {
		description:
			'This torrent is registered, but no background download is running.',
		title: 'Not downloading on the server',
	}
}

const StatusIcon = ({
	phase,
	status,
}: Pick<TorrentServerStatusProps, 'phase' | 'status'>) => {
	if (phase === 'not-found') {
		return <ShieldAlert aria-hidden='true' className='h-5 w-5 text-amber-600' />
	}
	if (
		phase === 'connection-error' ||
		phase === 'metadata-error' ||
		phase === 'registration-error' ||
		status?.state === 'failed'
	) {
		return <CircleX aria-hidden='true' className='h-5 w-5 text-destructive' />
	}
	if (status?.state === 'completed') {
		return (
			<CircleCheck aria-hidden='true' className='h-5 w-5 text-emerald-600' />
		)
	}
	if (status?.state === 'downloading') {
		return <CloudDownload aria-hidden='true' className='h-5 w-5 text-primary' />
	}
	if (status?.state === 'idle') {
		return <CloudOff aria-hidden='true' className='h-5 w-5 text-amber-600' />
	}
	return (
		<LoaderCircle
			aria-hidden='true'
			className='h-5 w-5 animate-spin text-primary motion-reduce:animate-none'
		/>
	)
}

const TransferDetails = ({ status }: { status: TorrentServerStatusDto }) => {
	const progress = percentage(status)
	const hasByteProgress = status.downloadedBytes > 0 || status.totalBytes > 0
	return (
		<div>
			<div className='flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground text-sm'>
				{hasByteProgress ? (
					<span>
						{status.totalBytes > 0
							? `${Math.floor(progress)}% · ${formatBytes(status.downloadedBytes)} of ${formatBytes(status.totalBytes)}`
							: formatBytes(status.downloadedBytes)}
					</span>
				) : null}
				{status.state === 'downloading' && status.downloadSpeed > 0 ? (
					<span>{formatBytes(status.downloadSpeed)}/s</span>
				) : null}
				<span>
					{status.numPeers} {status.numPeers === 1 ? 'peer' : 'peers'}
				</span>
			</div>
		</div>
	)
}

const canRunServerAction = ({
	phase,
	serverAccessAllowed,
	status,
}: Pick<
	TorrentServerStatusProps,
	'phase' | 'serverAccessAllowed' | 'status'
>): boolean => {
	if (phase === 'not-found' || phase === 'registration-error') {
		return true
	}
	if (phase !== 'registered') {
		return false
	}
	return (
		!serverAccessAllowed ||
		status?.state === 'failed' ||
		status?.state === 'idle'
	)
}

const serverActionLabel = ({
	phase,
	serverAccessAllowed,
	status,
}: Pick<
	TorrentServerStatusProps,
	'phase' | 'serverAccessAllowed' | 'status'
>): string => {
	if (phase === 'registered' && !serverAccessAllowed) {
		return 'Open book'
	}
	if (status?.state === 'failed' || phase === 'registration-error') {
		return 'Retry server download'
	}
	return 'Start server download'
}

const isBusyStatus = (
	phase: TorrentServerPhase,
	status: TorrentServerStatusDto | null
): boolean =>
	phase === 'checking' ||
	phase === 'registering' ||
	status?.state === 'downloading' ||
	status?.state === 'fetching_metadata'

const CompactProgress = ({
	status,
}: {
	status: TorrentServerStatusDto | null
}) => {
	const value = status && status.totalBytes > 0 ? percentage(status) : undefined
	return (
		<progress
			aria-label='Server download progress'
			className='block h-1 w-full accent-primary'
			max={100}
			value={value}
		/>
	)
}

export const TorrentServerStatus = ({
	error,
	onAction,
	onRetry,
	phase,
	serverAccessAllowed,
	status,
}: TorrentServerStatusProps) => {
	const copy = statusCopy(phase, status, error)
	const isBusy = isBusyStatus(phase, status)
	const canRunAction = canRunServerAction({
		phase,
		serverAccessAllowed,
		status,
	})
	const actionLabel = serverActionLabel({
		phase,
		serverAccessAllowed,
		status,
	})
	const canRetry = phase === 'connection-error' || phase === 'metadata-error'

	return (
		<section
			aria-busy={isBusy}
			className='mx-2 mb-2'
			data-server-state={status?.state ?? phase}
		>
			<details className='group'>
				<summary className='cursor-pointer list-none rounded-md px-2 py-2 hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden'>
					<div className='flex items-center gap-2.5'>
						<StatusIcon phase={phase} status={status} />
						<div
							aria-atomic='true'
							aria-live='polite'
							className='min-w-0 flex-1'
						>
							<h2 className='truncate font-medium text-foreground text-sm'>
								{copy.title}
							</h2>
						</div>
						{status?.state === 'downloading' && status.totalBytes > 0 ? (
							<span className='text-muted-foreground text-xs tabular-nums'>
								{Math.floor(percentage(status))}%
							</span>
						) : null}
						<ChevronDown
							aria-hidden='true'
							className='h-4 w-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180'
						/>
					</div>
					{isBusy ? (
						<div className='mt-2 overflow-hidden rounded-full'>
							<CompactProgress status={status} />
						</div>
					) : null}
				</summary>
				<div className='ml-7 space-y-3 rounded-md bg-muted/40 px-3 py-3'>
					<p className='text-muted-foreground text-sm'>{copy.description}</p>
					{status ? <TransferDetails status={status} /> : null}
					{canRunAction || canRetry ? (
						<div className='flex flex-wrap gap-2'>
							{canRunAction ? (
								<Button onClick={onAction} size='sm' type='button'>
									{actionLabel}
								</Button>
							) : null}
							{canRetry ? (
								<Button
									onClick={onRetry}
									size='sm'
									type='button'
									variant='outline'
								>
									<RefreshCw aria-hidden='true' />
									Check again
								</Button>
							) : null}
						</div>
					) : null}
				</div>
			</details>
		</section>
	)
}

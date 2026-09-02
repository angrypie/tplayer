import { BookOpen } from 'lucide-react'
import React from 'react'
import { cn } from '~/lib/utils'
import { getFileUrl } from '~/routes/Playlist/api'
import { selectCoverCandidates } from '~/utils'

const DEFAULT_NORMALIZE_PATH = (pathParts) => pathParts

export const CoverImage = ({
	allowServer = true,
	ih,
	files = [],
	name = '',
	normalizePathParts = DEFAULT_NORMALIZE_PATH,
	className = 'w-16 h-16',
	imgClassName = 'w-full h-full object-cover',
	placeholderClassName = 'text-xs text-muted-foreground',
	loadingLabel = 'Loading cover...',
}) => {
	const [coverCandidates, setCoverCandidates] = React.useState([])
	const [coverUrl, setCoverUrl] = React.useState('')
	const [coverIndex, setCoverIndex] = React.useState(0)
	const [isCoverLoading, setIsCoverLoading] = React.useState(false)

	React.useEffect(() => {
		const candidateList = selectCoverCandidates(
			ih && Array.isArray(files) ? files : [],
			normalizePathParts
		)
		setCoverCandidates(candidateList)
		setCoverUrl('')
		setCoverIndex(0)
		setIsCoverLoading(false)
	}, [files, normalizePathParts, ih])

	React.useEffect(() => {
		if (!ih || coverCandidates.length === 0) {
			return
		}
		let isActive = true
		setIsCoverLoading(true)
		const loadCover = async () => {
			const candidate = coverCandidates[coverIndex]
			if (!candidate) {
				setIsCoverLoading(false)
				return
			}
			const url = await getFileUrl(ih, candidate.path, { allowServer })
			if (!isActive) {
				return
			}
			if (url) {
				setCoverUrl(url)
				setIsCoverLoading(false)
			} else {
				setCoverIndex((prev) => prev + 1)
			}
		}
		loadCover()
		return () => {
			isActive = false
		}
	}, [allowServer, ih, coverCandidates, coverIndex])

	React.useEffect(
		() => () => {
			if (coverUrl) {
				URL.revokeObjectURL(coverUrl)
			}
		},
		[coverUrl]
	)

	const handleImageError = React.useCallback(() => {
		setCoverIndex((previousIndex) => previousIndex + 1)
	}, [])

	return (
		<div
			className={cn(
				'flex shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted',
				className
			)}
		>
			{coverUrl ? (
				// biome-ignore lint/a11y/noNoninteractiveElementInteractions: A load error advances to the next cover candidate.
				<img
					alt={`${name} cover`}
					className={imgClassName}
					height={64}
					loading='lazy'
					onError={handleImageError}
					src={coverUrl}
					width={64}
				/>
			) : (
				<div className='flex h-full w-full items-center justify-center bg-gradient-to-br from-primary/15 via-muted to-accent'>
					{isCoverLoading && loadingLabel ? (
						<span className={cn('px-1 text-center', placeholderClassName)}>
							{loadingLabel}
						</span>
					) : (
						<BookOpen
							aria-hidden='true'
							className='size-5 text-muted-foreground'
						/>
					)}
				</div>
			)}
		</div>
	)
}

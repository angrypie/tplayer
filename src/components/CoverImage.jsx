import React from 'react'
import { getFileUrl } from '~/routes/Playlist/api'
import { selectCoverCandidates } from '~/utils'

const DEFAULT_NORMALIZE_PATH = (pathParts) => pathParts

export const CoverImage = ({
	ih,
	files = [],
	name = '',
	normalizePathParts = DEFAULT_NORMALIZE_PATH,
	className = 'w-16 h-16',
	imgClassName = 'w-full h-full object-cover',
	placeholderClassName = 'text-xs text-[var(--text-secondary)]',
	loadingLabel = 'Loading cover...',
	emptyLabel = 'No cover',
}) => {
	const [coverCandidates, setCoverCandidates] = React.useState([])
	const [coverUrl, setCoverUrl] = React.useState('')
	const [coverIndex, setCoverIndex] = React.useState(0)
	const [isCoverLoading, setIsCoverLoading] = React.useState(false)

	React.useEffect(() => {
		const candidateList = selectCoverCandidates(
			Array.isArray(files) ? files : [],
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
			const url = await getFileUrl(ih, candidate.path)
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
	}, [ih, coverCandidates, coverIndex])

	React.useEffect(() => {
		return () => {
			if (coverUrl) {
				URL.revokeObjectURL(coverUrl)
			}
		}
	}, [coverUrl])

	const containerClassName = [
		'rounded-lg',
		'overflow-hidden',
		'bg-[var(--bg-elevated)]',
		'flex',
		'items-center',
		'justify-center',
		className,
	]
		.filter(Boolean)
		.join(' ')

	const placeholderClassNames = ['text-center', 'px-1', placeholderClassName]
		.filter(Boolean)
		.join(' ')

	return (
		<div className={containerClassName}>
			{coverUrl ? (
				<img
					src={coverUrl}
					alt={`${name} cover`}
					className={imgClassName}
					loading='lazy'
					onError={() => setCoverIndex((prev) => prev + 1)}
				/>
			) : (
				<span className={placeholderClassNames}>
					{isCoverLoading ? loadingLabel : emptyLabel}
				</span>
			)}
		</div>
	)
}

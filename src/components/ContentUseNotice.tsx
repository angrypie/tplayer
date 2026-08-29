import { TriangleAlert } from 'lucide-react'
import { cn } from '~/lib/utils'
import {
	CONTENT_USE_COPYRIGHT_WARNING,
	CONTENT_USE_JURISDICTION_WARNING,
	CONTENT_USE_OWNERSHIP_WARNING,
	CONTENT_USE_P2P_WARNING,
	CONTENT_USE_TRACKER_WARNING,
} from '~/search/contentPolicy'

interface ContentUseNoticeProps {
	className?: string
	compact?: boolean
	id?: string
	includeThirdParty?: boolean
}

export const ContentUseNotice = ({
	className,
	compact = false,
	id,
	includeThirdParty = false,
}: ContentUseNoticeProps) => (
	<div
		className={cn(
			'rounded-lg border border-amber-500/50 bg-amber-500/10 p-4 text-sm',
			className
		)}
		id={id}
		role='note'
	>
		<div className='flex items-start gap-3'>
			<TriangleAlert
				aria-hidden='true'
				className='mt-0.5 h-5 w-5 shrink-0 text-amber-700 dark:text-amber-400'
			/>
			<div className='space-y-2'>
				<p className='font-semibold text-foreground'>
					Use only authorized content
				</p>
				<p>{CONTENT_USE_COPYRIGHT_WARNING}</p>
				{compact ? null : <p>{CONTENT_USE_OWNERSHIP_WARNING}</p>}
				<p>{CONTENT_USE_P2P_WARNING}</p>
				{includeThirdParty ? <p>{CONTENT_USE_TRACKER_WARNING}</p> : null}
				{compact ? null : <p>{CONTENT_USE_JURISDICTION_WARNING}</p>}
			</div>
		</div>
	</div>
)

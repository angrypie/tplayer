import { TriangleAlert } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '~/components/ui/alert'
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
	<Alert className={className} id={id} role='note' variant='warning'>
		<TriangleAlert aria-hidden='true' />
		<div>
			<AlertTitle>Use only authorized content</AlertTitle>
			<AlertDescription className='space-y-2'>
				<p>{CONTENT_USE_COPYRIGHT_WARNING}</p>
				{compact ? null : <p>{CONTENT_USE_OWNERSHIP_WARNING}</p>}
				<p>{CONTENT_USE_P2P_WARNING}</p>
				{includeThirdParty ? <p>{CONTENT_USE_TRACKER_WARNING}</p> : null}
				{compact ? null : <p>{CONTENT_USE_JURISDICTION_WARNING}</p>}
			</AlertDescription>
		</div>
	</Alert>
)

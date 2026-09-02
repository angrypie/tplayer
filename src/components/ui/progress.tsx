import type { ComponentProps } from 'react'
import { cn } from '~/lib/utils'

export const Progress = ({
	className,
	max = 100,
	...props
}: ComponentProps<'progress'>) => (
	<progress
		className={cn(
			'ui-progress block h-1.5 w-full overflow-hidden rounded-full',
			className
		)}
		max={max}
		{...props}
	/>
)

import type { ComponentProps } from 'react'
import { cn } from '~/lib/utils'

export const Checkbox = ({ className, ...props }: ComponentProps<'input'>) => (
	<input
		className={cn(
			'size-4 shrink-0 rounded border-input accent-primary focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
			className
		)}
		type='checkbox'
		{...props}
	/>
)

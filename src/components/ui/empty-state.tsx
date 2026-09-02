import type { LucideIcon } from 'lucide-react'
import type { ComponentProps, ReactNode } from 'react'
import { cn } from '~/lib/utils'

interface EmptyStateProps extends Omit<ComponentProps<'div'>, 'title'> {
	action?: ReactNode
	description?: ReactNode
	icon: LucideIcon
	title: ReactNode
}

export const EmptyState = ({
	action,
	className,
	description,
	icon: Icon,
	title,
	...props
}: EmptyStateProps) => (
	<div
		className={cn(
			'flex flex-col items-center rounded-xl border border-border/70 border-dashed bg-card/50 px-5 py-10 text-center',
			className
		)}
		{...props}
	>
		<div className='mb-3 grid size-11 place-items-center rounded-full bg-secondary text-secondary-foreground'>
			<Icon aria-hidden='true' className='size-5' />
		</div>
		<p className='font-medium'>{title}</p>
		{description ? (
			<p className='mt-1 max-w-sm text-muted-foreground text-sm'>
				{description}
			</p>
		) : null}
		{action ? <div className='mt-4'>{action}</div> : null}
	</div>
)

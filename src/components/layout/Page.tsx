import type { ComponentProps } from 'react'
import { cn } from '~/lib/utils'

export const PageShell = ({ className, ...props }: ComponentProps<'div'>) => (
	<div
		className={cn('flex h-dvh min-h-0 flex-col bg-background/70', className)}
		{...props}
	/>
)

export const PageContent = ({
	className,
	...props
}: ComponentProps<'main'>) => (
	<main
		className={cn('min-h-0 flex-1 overflow-y-auto px-4 py-6', className)}
		{...props}
	/>
)

interface SectionHeadingProps extends Omit<ComponentProps<'div'>, 'title'> {
	action?: React.ReactNode
	description?: React.ReactNode
	title: React.ReactNode
	titleAs?: 'h1' | 'h2' | 'h3'
	titleId?: string
}

export const SectionHeading = ({
	action,
	className,
	description,
	title,
	titleAs: Title = 'h2',
	titleId,
	...props
}: SectionHeadingProps) => (
	<div
		className={cn('flex items-start justify-between gap-4', className)}
		{...props}
	>
		<div className='min-w-0 space-y-1'>
			<Title className='font-semibold text-xl tracking-tight' id={titleId}>
				{title}
			</Title>
			{description ? (
				<p className='text-muted-foreground text-sm leading-relaxed'>
					{description}
				</p>
			) : null}
		</div>
		{action ? <div className='shrink-0'>{action}</div> : null}
	</div>
)

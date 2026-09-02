import { Slot } from '@radix-ui/react-slot'
import type { ComponentProps } from 'react'
import { cn } from '~/lib/utils'

interface CardProps extends ComponentProps<'div'> {
	asChild?: boolean
}

export const Card = ({ asChild = false, className, ...props }: CardProps) => {
	const Comp = asChild ? Slot : 'div'
	return (
		<Comp
			className={cn(
				'rounded-xl border border-border/80 bg-card text-card-foreground shadow-sm',
				className
			)}
			{...props}
		/>
	)
}

export const CardHeader = ({ className, ...props }: ComponentProps<'div'>) => (
	<div className={cn('space-y-1.5 p-4', className)} {...props} />
)

export const CardTitle = ({ className, ...props }: ComponentProps<'h3'>) => (
	<h3
		className={cn('font-semibold leading-none tracking-tight', className)}
		{...props}
	/>
)

export const CardDescription = ({
	className,
	...props
}: ComponentProps<'p'>) => (
	<p
		className={cn('text-muted-foreground text-sm leading-relaxed', className)}
		{...props}
	/>
)

export const CardContent = ({ className, ...props }: ComponentProps<'div'>) => (
	<div className={cn('p-4 pt-0', className)} {...props} />
)

export const CardFooter = ({ className, ...props }: ComponentProps<'div'>) => (
	<div className={cn('flex items-center p-4 pt-0', className)} {...props} />
)

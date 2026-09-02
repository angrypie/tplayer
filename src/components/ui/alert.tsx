import { cva, type VariantProps } from 'class-variance-authority'
import type { ComponentProps } from 'react'
import { cn } from '~/lib/utils'

const alertVariants = cva(
	'relative w-full rounded-xl border p-4 text-sm [&>svg+div]:pl-8 [&>svg]:absolute [&>svg]:top-4 [&>svg]:left-4 [&>svg]:size-5',
	{
		defaultVariants: { variant: 'default' },
		variants: {
			variant: {
				default: 'border-border bg-card text-card-foreground',
				destructive:
					'border-destructive/35 bg-destructive/10 text-foreground [&>svg]:text-destructive',
				success:
					'border-success/35 bg-success/10 text-foreground [&>svg]:text-success',
				warning:
					'border-warning/40 bg-warning/10 text-foreground [&>svg]:text-warning',
			},
		},
	}
)

interface AlertProps
	extends ComponentProps<'div'>,
		VariantProps<typeof alertVariants> {}

export const Alert = ({ className, variant, ...props }: AlertProps) => (
	<div className={cn(alertVariants({ variant }), className)} {...props} />
)

export const AlertTitle = ({ className, ...props }: ComponentProps<'p'>) => (
	<p className={cn('mb-1 font-semibold leading-none', className)} {...props} />
)

export const AlertDescription = ({
	className,
	...props
}: ComponentProps<'div'>) => (
	<div
		className={cn('text-muted-foreground leading-relaxed', className)}
		{...props}
	/>
)

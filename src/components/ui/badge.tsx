import { cva, type VariantProps } from 'class-variance-authority'
import type { ComponentProps } from 'react'
import { cn } from '~/lib/utils'

const badgeVariants = cva(
	'inline-flex w-fit items-center rounded-full border px-2 py-0.5 font-medium text-xs',
	{
		defaultVariants: { variant: 'secondary' },
		variants: {
			variant: {
				default: 'border-transparent bg-primary text-primary-foreground',
				outline: 'border-border bg-transparent text-muted-foreground',
				secondary: 'border-transparent bg-secondary text-secondary-foreground',
				success:
					'border-success/25 bg-success/10 text-success dark:text-success-foreground',
				warning:
					'border-warning/25 bg-warning/10 text-warning dark:text-warning-foreground',
			},
		},
	}
)

interface BadgeProps
	extends ComponentProps<'span'>,
		VariantProps<typeof badgeVariants> {}

export const Badge = ({ className, variant, ...props }: BadgeProps) => (
	<span className={cn(badgeVariants({ variant }), className)} {...props} />
)

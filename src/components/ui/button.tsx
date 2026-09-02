import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'
import type { ButtonHTMLAttributes, Ref } from 'react'

import { cn } from '~/lib/utils'

const buttonVariants = cva(
	'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md font-medium text-sm shadow-xs ring-offset-background transition-[background-color,color,border-color,box-shadow,transform] focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 active:translate-y-px disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0',
	{
		defaultVariants: {
			size: 'default',
			variant: 'default',
		},
		variants: {
			size: {
				default: 'h-10 px-4 py-2',
				icon: 'h-10 w-10',
				lg: 'h-11 rounded-md px-8',
				sm: 'h-9 rounded-md px-3',
			},
			variant: {
				default: 'bg-primary text-primary-foreground hover:bg-primary/90',
				destructive:
					'bg-destructive text-destructive-foreground hover:bg-destructive/90',
				ghost: 'shadow-none hover:bg-accent hover:text-accent-foreground',
				link: 'text-primary underline-offset-4 hover:underline',
				outline:
					'border border-input bg-card hover:border-primary/30 hover:bg-accent hover:text-accent-foreground',
				secondary:
					'bg-secondary text-secondary-foreground hover:bg-secondary/80',
			},
		},
	}
)

export interface ButtonProps
	extends ButtonHTMLAttributes<HTMLButtonElement>,
		VariantProps<typeof buttonVariants> {
	asChild?: boolean
	ref?: Ref<HTMLButtonElement>
}

const Button = ({
	className,
	variant,
	size,
	asChild = false,
	ref,
	...props
}: ButtonProps) => {
	const Comp = asChild ? Slot : 'button'
	return (
		<Comp
			className={cn(buttonVariants({ className, size, variant }))}
			ref={ref}
			{...props}
		/>
	)
}
Button.displayName = 'Button'

export { Button, buttonVariants }

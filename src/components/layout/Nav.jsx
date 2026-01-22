import React from 'react'
import { cn } from '~/lib/utils'

export const Nav = ({ className, children, ...props }) => (
	<nav className={cn('flex items-center gap-2 px-3 py-2', className)} {...props}>
		{children}
	</nav>
)

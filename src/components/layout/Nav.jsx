import { cn } from '~/lib/utils'

export const Nav = ({ className, children, ...props }) => (
	<nav
		className={cn(
			'flex min-h-16 items-center gap-2 border-border/70 border-b bg-background/85 px-4 py-3 backdrop-blur-xl',
			className
		)}
		{...props}
	>
		{children}
	</nav>
)

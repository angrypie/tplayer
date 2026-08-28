import { Moon, Sun } from 'lucide-react'
import { useCallback } from 'react'
import { useTheme } from '~/components/theme-provider'
import { Button } from '~/components/ui/button'

interface ThemeToggleProps {
	className?: string
}

const getResolvedTheme = (theme: string) => {
	if (theme === 'system') {
		if (typeof window === 'undefined') {
			return 'light'
		}
		return window.matchMedia('(prefers-color-scheme: dark)').matches
			? 'dark'
			: 'light'
	}
	return theme
}

export function ThemeToggle({ className }: ThemeToggleProps) {
	const { theme, setTheme } = useTheme()
	const resolvedTheme = getResolvedTheme(theme)
	const isDark = resolvedTheme === 'dark'

	const handleToggle = useCallback(() => {
		setTheme(isDark ? 'light' : 'dark')
	}, [isDark, setTheme])

	return (
		<Button
			aria-label='Toggle theme'
			className={className}
			onClick={handleToggle}
			size='icon'
			type='button'
			variant='outline'
		>
			{isDark ? <Sun className='h-4 w-4' /> : <Moon className='h-4 w-4' />}
		</Button>
	)
}

import { ArrowLeft, Image, ImageOff } from 'lucide-react'
import { Link } from 'wouter'
import { Nav as BaseNav } from '~/components/layout/Nav'
import { ThemeToggle } from '~/components/theme-toggle'
import { Button } from '~/components/ui/button'

export const Nav = ({ showCover, onToggleCover }) => (
	<BaseNav>
		<Button asChild type='button' variant='outline'>
			<Link href='/'>
				<ArrowLeft className='h-4 w-4' />
				<span className='hidden sm:inline'>Back to library</span>
			</Link>
		</Button>
		<div className='min-w-0 flex-1'>
			<p className='truncate font-medium text-sm'>Now playing</p>
			<p className='truncate text-muted-foreground text-xs'>Audiobook player</p>
		</div>
		<Button
			aria-pressed={showCover}
			onClick={onToggleCover}
			type='button'
			variant='outline'
		>
			{showCover ? (
				<ImageOff className='h-4 w-4' />
			) : (
				<Image className='h-4 w-4' />
			)}
			<span className='hidden sm:inline'>
				{showCover ? 'Hide cover' : 'Show cover'}
			</span>
		</Button>
		<ThemeToggle />
	</BaseNav>
)

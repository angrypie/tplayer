import { Moon, Sun } from "lucide-react"
import { Button } from "~/components/ui/button"
import { useTheme } from "~/components/theme-provider"

type ThemeToggleProps = {
	className?: string
}

const getResolvedTheme = (theme: string) => {
	if (theme === "system") {
		if (typeof window === "undefined") {
			return "light"
		}
		return window.matchMedia("(prefers-color-scheme: dark)").matches
			? "dark"
			: "light"
	}
	return theme
}

export function ThemeToggle({ className }: ThemeToggleProps) {
	const { theme, setTheme } = useTheme()
	const resolvedTheme = getResolvedTheme(theme)
	const isDark = resolvedTheme === "dark"

	const handleToggle = () => {
		setTheme(isDark ? "light" : "dark")
	}

	return (
		<Button
			variant="outline"
			size="icon"
			onClick={handleToggle}
			className={className}
			type="button"
			aria-label="Toggle theme"
		>
			{isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
		</Button>
	)
}

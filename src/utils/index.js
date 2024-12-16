import { clsx } from "clsx"
import { twMerge } from "tailwind-merge"

export const comparePath = (a, b) => a.join('/') === b.join('')


export function cn(...inputs) {
	return twMerge(clsx(inputs))
}


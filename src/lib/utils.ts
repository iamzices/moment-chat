import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'
/**
 * Join class names, letting later Tailwind classes override conflicting earlier ones.
 * @param inputs - Class strings, arrays or conditional objects, as accepted by clsx.
 * @returns The merged class string.
 */
export function cn(...inputs: ClassValue[]) { return twMerge(clsx(inputs)) }

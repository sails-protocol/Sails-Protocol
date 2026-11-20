import { useTheme } from '../../context/ThemeContext'
import { Sun, Moon } from 'lucide-react'

export function ThemeToggle() {
  const { theme, toggleTheme } = useTheme()
  return (
    <button
      type="button"
      onClick={toggleTheme}
      aria-label="Alternar tema"
      // 44px hit area around the 32px visual square; -m-1.5 keeps the layout footprint at 32px.
      className="group -m-1.5 h-11 w-11 flex items-center justify-center rounded-lg text-brand-text-secondary hover:text-brand-text focus-visible:outline-none"
    >
      <span className="w-8 h-8 flex items-center justify-center rounded-lg border border-brand-border transition-colors group-hover:border-brand-border-hover group-focus-visible:ring-2 group-focus-visible:ring-ring">
        {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
      </span>
    </button>
  )
}

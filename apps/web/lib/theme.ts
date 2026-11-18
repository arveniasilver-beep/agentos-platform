// Light/dark/auto theme, persisted to localStorage and applied by toggling `.dark` on <html>.
// Light is the default (Manus-like). `auto` follows the OS preference.
export type Theme = 'light' | 'dark' | 'auto';

const KEY = 'agentos-theme';

export function getTheme(): Theme {
  if (typeof localStorage === 'undefined') return 'light';
  const v = localStorage.getItem(KEY);
  return v === 'dark' || v === 'auto' ? v : 'light';
}

export function applyTheme(theme: Theme): void {
  if (typeof document === 'undefined') return;
  const prefersDark =
    typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: dark)').matches;
  const dark = theme === 'dark' || (theme === 'auto' && prefersDark);
  document.documentElement.classList.toggle('dark', dark);
}

export function setTheme(theme: Theme): void {
  if (typeof localStorage !== 'undefined') localStorage.setItem(KEY, theme);
  applyTheme(theme);
}

/** Re-apply the theme when the OS light/dark preference changes (only matters while set to 'auto').
 * Returns an unsubscribe function. */
export function watchSystemTheme(): () => void {
  if (typeof matchMedia === 'undefined') return () => undefined;
  const mq = matchMedia('(prefers-color-scheme: dark)');
  const handler = () => {
    if (getTheme() === 'auto') applyTheme('auto');
  };
  mq.addEventListener('change', handler);
  return () => mq.removeEventListener('change', handler);
}

/** Inline, render-blocking bootstrap so there is no light/dark flash before React hydrates. */
export const THEME_BOOTSTRAP = `(function(){try{var t=localStorage.getItem('${KEY}')||'light';var d=t==='dark'||(t==='auto'&&matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.classList.toggle('dark',d);}catch(e){}})();`;

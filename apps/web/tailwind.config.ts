import type { Config } from 'tailwindcss';

/**
 * Theming: the whole app is written in `slate-*` shades. Instead of rewriting every component, the
 * slate scale is mapped to CSS variables (see globals.css). In dark mode the scale holds its normal
 * values; in light mode it is INVERTED (slate-950 = white page bg, slate-100 = near-black text), so a
 * single class set renders a clean light theme (Manus-like) or the original dark theme. Accent colors
 * (emerald/rose/amber/…) keep Tailwind's defaults and read well on both.
 */
const slate = Object.fromEntries(
  ([50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950] as const).map((n) => [
    n,
    `rgb(var(--slate-${n}) / <alpha-value>)`,
  ]),
);

const config: Config = {
  darkMode: 'class',
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}', './lib/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: { slate },
      fontFamily: {
        serif: ['Georgia', 'Cambria', '"Times New Roman"', 'serif'],
      },
    },
  },
  plugins: [],
};

export default config;

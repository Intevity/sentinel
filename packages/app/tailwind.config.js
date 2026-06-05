/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  // 'class' so the theme effect can override the OS preference. The
  // useThemeEffect hook adds/removes `.dark` on <html> based on
  // settings.theme; the FOWT script in index.html pre-applies the
  // class from localStorage to avoid a flash on launch.
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        ios: {
          blue: '#007AFF',
          green: '#32D74B',
          orange: '#FF9F0A',
          red: '#FF453A',
          purple: '#BF5AF2',
          indigo: '#5E5CE6',
          gray: '#8E8E93',
        },
        // Semantic theme tokens backed by CSS vars in index.css. The
        // `<alpha-value>` placeholder lets the `/N` opacity modifier
        // keep working (e.g. `text-foreground/60`). RGB values must be
        // space-separated triplets, not `rgb(...)` — required by
        // Tailwind for the alpha-value substitution.
        foreground: 'rgb(var(--foreground) / <alpha-value>)',
        muted: 'rgb(var(--muted) / <alpha-value>)',
        'border-subtle': 'rgb(var(--border-subtle) / <alpha-value>)',
        'surface-overlay': 'rgb(var(--surface-overlay) / <alpha-value>)',
      },
      fontFamily: {
        sans: [
          '-apple-system',
          'BlinkMacSystemFont',
          "'SF Pro Text'",
          "'Helvetica Neue'",
          'sans-serif',
        ],
      },
      fontSize: {
        '2xs': ['10px', { lineHeight: '14px' }],
      },
      boxShadow: {
        card: '0 1px 4px rgba(0,0,0,0.07), 0 0 0 0.5px rgba(0,0,0,0.05)',
        'card-md': '0 4px 20px rgba(0,0,0,0.10), 0 0 0 0.5px rgba(0,0,0,0.05)',
        // Pinned sticky chrome (e.g. the Optimize savings bar): pronounced
        // enough to clearly separate the floating card from content scrolling
        // beneath it. The dark variant needs far higher opacity — soft black
        // shadows all but vanish on the #111 page background.
        sticky:
          '0 8px 24px rgba(0,0,0,0.22), 0 2px 8px rgba(0,0,0,0.12), 0 0 0 0.5px rgba(0,0,0,0.06)',
        'sticky-dark': '0 10px 28px rgba(0,0,0,0.70), 0 2px 8px rgba(0,0,0,0.50)',
      },
      borderRadius: {
        '2xl': '16px',
        '3xl': '22px',
      },
      backdropBlur: {
        xs: '4px',
      },
    },
  },
  plugins: [],
};

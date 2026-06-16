/** @type {import('tailwindcss').Config} */
// Mirrors packages/app/tailwind.config.js so a component dropped from the app
// renders identically on the web. Keep the ios.* palette, font stack, radius,
// and shadow scale in sync with the app.
export default {
  content: ['./src/**/*.{astro,html,js,jsx,ts,tsx,md,mdx}'],
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
        // Semantic theme tokens backed by CSS vars in src/styles/global.css.
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
        display: ['clamp(2.75rem, 6vw, 4.5rem)', { lineHeight: '1.05', letterSpacing: '-0.02em' }],
      },
      boxShadow: {
        card: '0 1px 4px rgba(0,0,0,0.07), 0 0 0 0.5px rgba(0,0,0,0.05)',
        'card-md': '0 4px 20px rgba(0,0,0,0.10), 0 0 0 0.5px rgba(0,0,0,0.05)',
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

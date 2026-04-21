/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  darkMode: 'media',
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

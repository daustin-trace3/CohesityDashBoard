/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx,ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Legacy token names kept so every existing page inherits the new palette.
        'cohesity-black': '#0B1015',
        'cohesity-green': '#6CB33F',
        'cohesity-green-dark': '#54932D',
        'cohesity-gray': '#131B23',
        'cohesity-text': '#E8EDF2',
        'cohesity-border': '#1F2B37',
        // New design-system tokens
        surface: {
          base: '#0B1015',
          DEFAULT: '#131B23',
          raised: '#18222C',
          overlay: '#1E2A36',
        },
        ink: {
          DEFAULT: '#E8EDF2',
          muted: '#94A3B3',
          faint: '#5F7081',
        },
        brand: {
          DEFAULT: '#6CB33F',
          bright: '#82C957',
          dark: '#54932D',
        },
        status: {
          ok: '#34D399',
          warn: '#FBBF24',
          crit: '#F87171',
          info: '#60A5FA',
        },
      },
      fontFamily: {
        sans: ['Inter', 'InterVariable', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Roboto', 'sans-serif'],
        mono: ['JetBrains Mono', 'SFMono-Regular', 'Consolas', 'Menlo', 'monospace'],
      },
      boxShadow: {
        panel: '0 1px 2px rgba(0,0,0,0.4), 0 0 0 1px rgba(255,255,255,0.02) inset',
        'panel-hover': '0 4px 16px rgba(0,0,0,0.45), 0 0 0 1px rgba(108,179,63,0.18)',
        modal: '0 24px 64px rgba(0,0,0,0.6)',
        'glow-green': '0 0 12px rgba(108,179,63,0.35)',
      },
      keyframes: {
        shimmer: {
          '0%': { backgroundPosition: '-400px 0' },
          '100%': { backgroundPosition: '400px 0' },
        },
        'fade-in': {
          from: { opacity: '0', transform: 'translateY(4px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        'slide-in-right': {
          from: { opacity: '0', transform: 'translateX(16px)' },
          to: { opacity: '1', transform: 'translateX(0)' },
        },
        'loading-bar': {
          '0%': { left: '-40%', width: '40%' },
          '50%': { left: '30%', width: '50%' },
          '100%': { left: '100%', width: '40%' },
        },
      },
      animation: {
        shimmer: 'shimmer 1.6s linear infinite',
        'fade-in': 'fade-in 220ms ease-out both',
        'slide-in-right': 'slide-in-right 240ms ease-out both',
        'loading-bar': 'loading-bar 1.1s ease-in-out infinite',
      },
    },
  },
  plugins: [],
};

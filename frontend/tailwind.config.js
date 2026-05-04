/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx,ts,tsx}'],
  theme: {
    extend: {
      colors: {
        'cohesity-black': '#1A1A1A',
        'cohesity-green': '#6CB33F',
        'cohesity-green-dark': '#4d8a2a',
        'cohesity-gray': '#2C2C2C',
        'cohesity-text': '#E5E5E5',
        'cohesity-border': '#3D3D3D'
      }
    }
  },
  plugins: []
};

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        navy: {
          50: '#eef4ff',
          100: '#d9e6ff',
          500: '#1d4ed8',
          600: '#1e40af',
          700: '#1e3a8a',
          800: '#172554',
          900: '#0f1f3d',
          950: '#0a1526',
        },
        brand: {
          DEFAULT: '#1d4ed8',
          light: '#3b82f6',
          dark: '#1e3a8a',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
      },
      boxShadow: {
        card: '0 1px 3px rgba(15, 31, 61, 0.08), 0 1px 2px rgba(15, 31, 61, 0.06)',
      },
    },
  },
  plugins: [],
};

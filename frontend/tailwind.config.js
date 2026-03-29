/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        forest: {
          bg:      '#0d1209',
          surface: '#121710',
          raised:  '#1a2115',
          border:  '#242e1c',
        },
        ink: {
          DEFAULT: '#e2ddd5',
          muted:   '#7a7d6f',
          heading: '#eeeae2',
        },
      },
      fontFamily: {
        fraunces:  ['Fraunces', 'Georgia', 'serif'],
        'ibm-plex': ['IBM Plex Sans', 'system-ui', 'sans-serif'],
        'ibm-mono': ['IBM Plex Mono', 'Courier New', 'monospace'],
      },
    },
  },
  plugins: [],
}

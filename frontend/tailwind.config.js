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
          bg:      '#0b0f0d',
          surface: '#111714',
          raised:  '#192219',
          border:  '#263327',
        },
        ink: {
          DEFAULT: '#dce8e2',
          muted:   '#7a9188',
          heading: '#e8f5ef',
        },
      },
      fontFamily: {
        syne:      ['Syne', 'system-ui', 'sans-serif'],
        'ibm-plex': ['IBM Plex Sans', 'system-ui', 'sans-serif'],
        'ibm-mono': ['IBM Plex Mono', 'Courier New', 'monospace'],
      },
    },
  },
  plugins: [],
}

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
        terminal: {
          bg:      '#0d0d0d',
          surface: '#141414',
          raised:  '#1c1c1c',
          border:  '#2a2a2a',
        },
        neon: {
          DEFAULT: '#00ff41',
          dim:     '#00cc33',
          border:  'rgba(0,255,65,0.25)',
          bg:      'rgba(0,255,65,0.06)',
        },
        ink: {
          DEFAULT: '#c8c8c8',
          muted:   '#555555',
          heading: '#ffffff',
        },
      },
      fontFamily: {
        grotesk:   ['Space Grotesk', 'system-ui', 'sans-serif'],
        'ibm-mono': ['IBM Plex Mono', 'Courier New', 'monospace'],
      },
    },
  },
  plugins: [],
}

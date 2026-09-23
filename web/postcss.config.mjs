/**
 * Tailwind CSS v4 uses the dedicated PostCSS plugin - not the legacy
 * `tailwindcss` one - and needs no tailwind.config.js; theming lives in
 * app/globals.css via @theme.
 */
export default {
  plugins: {
    "@tailwindcss/postcss": {},
  },
};

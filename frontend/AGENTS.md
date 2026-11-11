# figma-make-app

React + Vite project running inside Figma Make, styled with plain CSS and design tokens.

## Development Server

A Vite development server is **already running** on `$PORT` (default 8443). You don't need to start it manually.

- Preview URL: The user can access the running app through the preview panel
- Hot reload: Changes to source files are reflected immediately

## Project Structure

This is the canonical project structure. Start with task-relevant files below. Only follow imports or inspect other files when required, when a documented path is missing, or when the repository contradicts this guide.

- `src/main.tsx` - React entrypoint; imports `src/ui/tokens.css`, `src/ui/base.css` and `src/ui/layout.css`, and mounts `src/App.tsx` into the `#root` element
- `src/App.tsx` - Primary application component and the usual starting point for UI work
- `src/ui/` - the in-app UI library: design tokens (`tokens.css`), base element styles (`base.css`), shared page layout (`layout.css`) and primitives (see `src/ui/README.md`)
- `index.html` - Vite HTML shell containing the `#root` element and loading `src/main.tsx`
- `package.json` - Project dependencies and the Vite build, development, preview, and formatting scripts
- `vite.config.ts` - Vite configuration with React and Figma Make plugins plus the `@` alias for `src`
- `.mise.toml` - Toolchain versions for Node.js and pnpm

## Dependencies

- Runtime: React 19 and React DOM 19
- Styling: plain CSS with CSS custom properties (no Tailwind)
- Build tooling: Vite 8, TypeScript 5.7, and `@vitejs/plugin-react`
- Formatting: oxfmt

## Styling

Plain CSS and CSS custom properties; Tailwind is not installed. Use the tokens in `src/ui/tokens.css` (`--color-*`, spacing, radii, shadows, font sizes, z-index layers) rather than literal colours. Dark mode is the single `.theme-dark` block in `tokens.css`, which redefines the tokens: don't add per-component `.theme-dark` overrides. Each component keeps its CSS in a `.css` file next to it, imported from the component. Reuse the primitives exported from `src/ui/index.ts` (`Button`, `IconButton`, `Card`, `Eyebrow`, `Popover`, `Sheet`).

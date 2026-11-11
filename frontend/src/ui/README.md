# `src/ui` — the AdaptAI UI library

An in-app library: design tokens, page-wide base styles and a few primitives. Plain CSS and
CSS custom properties, one `.css` file next to each component. No Tailwind.

`main.tsx` imports, in this order: `ui/tokens.css`, `ui/base.css`, then `index.css` (the
screens not migrated yet). Each primitive imports its own CSS.

## Rules

- Use tokens, never literal colours. If a colour you need has no token, add one to
  `tokens.css` (light value on `:root`, dark value in `.theme-dark`).
- Dark mode is the single `.theme-dark { … }` block in `tokens.css`. Components never carry
  their own `.theme-dark` overrides.
- Keep every `data-*` hook, `aria-*` label and role the e2e tests use (`e2e/*.spec.ts`,
  `e2e/helpers.ts`). All primitives pass native props through.

## Tokens

All in `tokens.css`. Light values on `:root`, dark values in `.theme-dark`.

| Group | Tokens |
| --- | --- |
| Surfaces | `--color-bg` (page), `--color-surface` (cards, panels, message box), `--color-control`, `--color-hover`, `--color-hover-strong` |
| Text | `--color-text`, `--color-ink`, `--color-ink-max`, `--color-heading-strong`, `--color-heading`, `--color-heading-soft`, `--color-body`, `--color-ink-soft`, `--color-label`, `--color-muted`, `--color-subtle`, `--color-placeholder` |
| Lines | `--color-line`, `--color-line-soft`, `--color-line-strong`, `--color-line-quiet`, `--color-line-control`, `--color-line-control-hover` |
| Accent and states | `--color-accent`, `--color-accent-hover`, `--color-accent-strong`, `--color-accent-ink` (text on accent), `--color-focus`, `--color-danger`, `--color-danger-line`, `--color-success`, `--color-success-soft`, `--color-warm`, `--color-warm-soft`, `--color-scrim`, `--color-scrim-strong` |
| Component tokens | `--sidebar-bg`, `--button-*`, `--toggle-ink`, `--status-*`, `--composer-chat-ink`: light/dark pairs that don't fit the palette without a visible change. Candidates to fold in later. |
| Shadows | `--shadow-sidebar`, `--shadow-sidebar-compact`, `--shadow-card`, `--shadow-raised`, `--shadow-raised-compact`, `--shadow-button`, `--shadow-popover`, `--shadow-panel`, `--shadow-drawer` |
| Spacing | `--space-1` 4px, `--space-2` 8, `--space-3` 12, `--space-4` 16, `--space-5` 20, `--space-6` 24, `--space-8` 32 |
| Radii | `--radius-sm` 8px, `--radius-control` 9, `--radius-md` 10, `--radius-bubble` 14, `--radius-lg` 16, `--radius-xl` 18, `--radius-pill` |
| Type | `--font-sans`, `--font-mono`; `--text-xs` 11px, `--text-sm` 12, `--text-base` 13, `--text-md` 14, `--text-lg` 15, `--text-xl` 16; `--weight-regular` 400, `--weight-medium` 500, `--weight-semibold` 600, `--weight-bold` 650, `--weight-heavy` 700 |
| Layers | `--z-tooltip` 10, `--z-coach` 20, `--z-sidebar` 30, `--z-panel` 35 (analysis panel, floating), `--z-composer` 36 (message box, above the panel), `--z-sidebar-backdrop` 44, `--z-sidebar-drawer` 45, `--z-sheet` 45 (analysis bottom sheet), `--z-toast` 50 |

Old names still work as aliases, for code not migrated yet: `--ink`, `--muted`, `--line`,
`--surface`, `--blue`, `--blue-dark`, `--blue-soft`, `--green`. Don't use them in new code.

`base.css` holds an `@layer base` block with the parts of Tailwind's preflight the app was
built on (so unlayered rules still win over it), plus element defaults, focus rings, `.muted`
and `.sr-only`.

## Primitives

Import from `./ui` (or `../ui`).

### Button

`variant`: `primary` (default) · `secondary` · `ghost` · `danger`. `size`: `md` (default) · `sm`.
Forwards its ref and every native prop; `type` defaults to `button`.

```tsx
<Button onClick={send} data-chat-send="">Send</Button>
<Button variant="secondary" size="sm" aria-label="Refresh progress">Refresh</Button>
```

### IconButton

A square, borderless button for one icon or glyph. Always give it an `aria-label`.

```tsx
<IconButton aria-label="Close menu" onClick={close}>×</IconButton>
```

### Card

A bordered surface, rendered as `<section>`. Padding is up to the content.

```tsx
<Card className="dashboard-card"><Eyebrow>My progress</Eyebrow><h2>Your judgement over time</h2></Card>
```

### Eyebrow

The small upper-case label above a title.

```tsx
<Eyebrow>Analysis</Eyebrow>
```

### Popover + usePopover

A pop-over anchored to a trigger, built on the browser's `popover="auto"`: outside click and
Escape close it and focus returns to the trigger. The hook adds the open state (for
`aria-expanded`) and places the panel under the trigger, or above it when there's more room,
inside the window.

```tsx
const popover = usePopover({ id: 'assessment-model-picker', width: 360, maxHeight: 480, focusOnOpen: 'button[aria-pressed="true"]' })
return <>
  <button {...popover.triggerProps} type="button" aria-label="Chat model: Auto">Auto</button>
  <Popover handle={popover} role="dialog" aria-label="Choose assessment model">
    <button type="button" onClick={() => { choose('auto'); popover.close() }}>Auto</button>
  </Popover>
</>
```

Options: `width`, `maxHeight`, `minHeight` (default 80), `focusOnOpen` (a selector inside the
panel), `watch` (values that resize the panel while open). `popover.hide()` closes without
moving focus; `popover.close()` also returns focus to the trigger.

### Sheet + useSheetClearance

The analysis panel's two modes. Above 1100px it floats over the right of the page and stops
`--composer-space` above the bottom of the window. At 1100px and below it becomes a nearly
full-height bottom sheet with a backdrop. It closes with its × button, the backdrop or Escape.

```tsx
// In the screen that owns the message box:
const composerSpace = useSheetClearance(composerRef, { active: pageIsActive })
<div style={{ '--composer-space': `${composerSpace}px` } as CSSProperties}>…</div>

// The panel:
<Sheet open={open} onClose={close} label="Analysis" closeLabel="Close analysis"
  heading={<><Eyebrow>Analysis</Eyebrow><h2>Your task</h2></>}
  footer={<Button data-drawer-send="" onClick={send}>Send this message</Button>}
  panelProps={{ 'data-analysis-drawer': '' }}>
  …
</Sheet>
```

## Migration status

On `ui/` (own CSS file, tokens only): Sidebar, ChatScreen (with the composer and
ChatMarkdown), AnalysisDrawer (→ `Sheet`), ModelPicker and OpenRouterModelPicker
(→ `Popover`). `Button` has moved out of `App.tsx` and `Card` out of `AnalysisResult.tsx`.

Still on `index.css`:

- [ ] My progress — `Progress.tsx`, `ProgressDashboard.tsx`, `LearningProgress.tsx`, `HistoryAnalysis.tsx`
- [ ] Profile — `Profile.tsx`
- [ ] LLM config — `LLMConfig.tsx`
- [ ] Prompt Coach — `PromptCoachBubble.tsx` (its own pop-up logic → `Popover`), `PromptCoachToggle.tsx`
- [ ] Task outcomes — `TaskOutcome*.tsx`
- [ ] The legacy Assistant screen in `App.tsx`
- [ ] The auth screen in `Account.tsx`

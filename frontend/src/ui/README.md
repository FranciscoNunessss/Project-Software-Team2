# `src/ui` — the AdaptAI UI library

An in-app library: design tokens, page-wide base styles and a few primitives. Plain CSS and
CSS custom properties, one `.css` file next to each component. No Tailwind.

`main.tsx` imports, in this order: `ui/tokens.css`, `ui/base.css`, the primitives, then
`ui/layout.css` (the page column, intro header, section headings and a few blocks several
screens share). Every other component imports its own `.css` file. There is no `index.css`.

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
| More text | `--color-muted-soft`, `--color-muted-softer` (fine print), `--color-caption` (beside section headings), `--color-info`, `--color-info-soft` |
| Component tokens | Light/dark pairs that don't fit the palette without a visible change; candidates to fold in later. Shell: `--sidebar-bg`, `--button-*`, `--toggle-ink`, `--status-*`, `--composer-chat-ink`, `--footer-*`. Labels and tiles: `--pill-*`, `--icon-tile-*`, `--note-*`, `--inset-bg`, `--well-*` (outlined label), `--tooltip-*`, `--empty-*`, `--skeleton-bg`, `--detail-ink*`. Analysis: `--track-bg`, `--bar-fill`, `--tier-line`, `--fit-*`, `--status-ok-*` / `--status-warn-*` / `--status-bad-*`. Legacy Assistant: `--segments-*`, `--segment-selected-*`, `--override-applied-*`. My progress: `--chart-*`, `--choice-pending-*`, `--trend-*`. Others: `--settings-eyebrow-ink`, `--provider-groq-line*`, `--auth-toggle-*`, `--auth-error-*`, `--coach-*` (Prompt Coach). |
| Fixed colours | The same in both themes, because the app never adapted them to dark mode: greys named by value (`--grey-5e` … `--grey-f8`), `--color-stale`, `--color-backdrop`, `--coach-error`, `--chart-analysed`, `--chart-confirmed`, `--switch-*`, `--badge-*` (model evaluation states). Candidates for semantic tokens later. |
| Shadows | `--shadow-sidebar`, `--shadow-sidebar-compact`, `--shadow-card`, `--shadow-raised`, `--shadow-raised-compact`, `--shadow-button`, `--shadow-popover`, `--shadow-panel`, `--shadow-drawer`, `--shadow-override`, `--shadow-tier`, `--shadow-segment-selected`, `--shadow-coach`, `--shadow-dialog`, `--shadow-tooltip` |
| Spacing | `--space-1` 4px, `--space-2` 8, `--space-3` 12, `--space-4` 16, `--space-5` 20, `--space-6` 24, `--space-8` 32 |
| Radii | `--radius-sm` 8px, `--radius-control` 9, `--radius-md` 10, `--radius-bubble` 14, `--radius-lg` 16, `--radius-xl` 18, `--radius-pill` |
| Type | `--font-sans`, `--font-mono`; `--text-xs` 11px, `--text-sm` 12, `--text-base` 13, `--text-md` 14, `--text-lg` 15, `--text-xl` 16; `--weight-regular` 400, `--weight-medium` 500, `--weight-semibold` 600, `--weight-bold` 650, `--weight-heavy` 700 |
| Layers | `--z-tooltip` 10, `--z-coach` 20, `--z-sidebar` 30, `--z-panel` 35 (analysis panel, floating), `--z-composer` 36 (message box, above the panel), `--z-sidebar-backdrop` 44, `--z-sidebar-drawer` 45, `--z-sheet` 45 (analysis bottom sheet), `--z-toast` 50 |

Old names still work as aliases: `--ink`, `--muted`, `--line`, `--surface`, `--blue`,
`--blue-dark`, `--blue-soft`, `--green`. No CSS uses them any more (one inline style in
`Sidebar.tsx` still reads `--surface`). Don't use them in new code.

Where the old CSS used two greys a few levels apart for the same role, they share one token.
Every such merge is within 4/255 per channel, which is not visible.

`base.css` holds an `@layer base` block with the parts of Tailwind's preflight the app was
built on (so unlayered rules still win over it), plus element defaults, focus rings, on/off
switches (`input[role="switch"]`), `.muted` and `.sr-only`.

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

### Sheet + useSheetRoom

The analysis panel's two modes. Above 1100px it floats full height (top to bottom of the
window) over the right of the page. At 1100px and below it becomes a nearly full-height
bottom sheet with a backdrop. It closes with its × button, the backdrop or Escape.

`useSheetRoom(container, open)` returns how many px an element has from the left of
`container` to just before the open floating panel (`null` when closed or a bottom sheet).
The chat uses it to narrow only the message box, so Analyse and Send stay usable while the
panel covers the rest of the chat.

```tsx
// In the screen that owns the message box:
const room = useSheetRoom(chatMainRef, panelOpen)
<section ref={chatMainRef} className={room === null ? 'chat-main' : 'chat-main beside-sheet'}
  style={room === null ? undefined : { '--sheet-room': `${room}px` } as CSSProperties}>…</section>

// The panel:
<Sheet open={open} onClose={close} label="Analysis" closeLabel="Close analysis"
  heading={<><Eyebrow>Analysis</Eyebrow><h2>Your task</h2></>}
  footer={<Button data-drawer-send="" onClick={send}>Send this message</Button>}
  panelProps={{ 'data-analysis-drawer': '' }}>
  …
</Sheet>
```

## Migration status

Every screen has its own CSS file on tokens, and `index.css` is gone:

- [x] Shell and chat: Sidebar, ChatScreen (composer, ChatMarkdown), AnalysisDrawer (→ `Sheet`), ModelPicker and OpenRouterModelPicker (→ `Popover`)
- [x] My progress: `Progress`, `ProgressDashboard`, `LearningProgress`, `HistoryAnalysis`, `CoachingPanel`, `TaskOutcomes`
- [x] Profile: `Profile` (and the settings card of `PromptCoachToggle`)
- [x] LLM config: `LLMConfig`, `ModelEvaluations`, `modelStatus`
- [x] Prompt Coach: `PromptCoachBubble` (styles only, see below), `TipsCard` / `PromptCoachTips`
- [x] Task outcomes: `TaskOutcome`, `TaskOutcomes`
- [x] The legacy Assistant screen and footer: `App.css`, with `AnalysisResult.css`
- [x] The auth screen: `Account`

Still to do in a later phase:

- [ ] `PromptCoachBubble` still has its own pop-up logic (outside click, Escape, placement); move it onto `Popover`.
- [ ] Replace hand-written `className="button button-…"` buttons on these screens with `Button`.
- [ ] Fold the component tokens and fixed colours into fewer semantic tokens (this changes how things look, so it needs a design decision).

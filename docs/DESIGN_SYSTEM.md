# Design system

Persona Voice uses a compact, dark desktop UI inspired by the information density and calm
workspace structure associated with Codex-style tools. It is an original Persona Voice interface,
not a replica or official OpenAI surface.

## Brand boundary

- The product name, waveform mark, app icon, layout implementation, CSS tokens, and UI copy are
  original Persona Voice materials unless a notice says otherwise.
- No OpenAI, ChatGPT, Codex, xAI, Grok, Grok Bot, or Cursor proprietary logo, icon pack, font, illustration, animation, or source
  asset is bundled.
- Product references to ChatGPT, Codex, and Grok Bot describe compatible source applications. They must not
  imply affiliation, endorsement, or ownership.
- Do not import screenshots or traced assets from another product to make the UI feel more exact.
  Extend the local token/component language instead.
- Third-party marks may be used only nominatively and with their applicable terms.

## Principles

1. **Truth before polish.** Ready, Armed, Running, Blocked, and Faulted must map to runtime state,
   not optimistic UI timing.
2. **One obvious primary action.** The Voice surface centers Start/Stop; setup blockers lead to
   diagnostics rather than hidden recovery.
3. **Quiet hierarchy.** Surfaces rely on spacing, typography, and subtle borders before shadows or
   saturated color.
4. **Local-first clarity.** History, storage, permissions, credits, and external links are explicit.
5. **Desktop-native behavior.** Preserve keyboard focus, drag regions, window controls, scrolling,
   and reduced-motion expectations.

## Token architecture

Canonical tokens live in `src/tokens.css`. Components should consume semantic tokens instead of
embedding new near-duplicate values.

### Surfaces and text

| Role | Token | Current value |
| --- | --- | --- |
| App underlay | `--surface-under` | `#141414` |
| Primary workspace | `--surface-primary` | `#181818` |
| Sidebar glass | `--surface-sidebar` | `rgb(24 24 24 / 82%)` |
| Resting control | `--surface-control` | `rgb(255 255 255 / 5.5%)` |
| Elevated opaque surface | `--surface-elevated-opaque` | `#222222` |
| Primary text | `--text-primary` | `#ffffff` |
| Secondary text | `--text-secondary` | `rgb(255 255 255 / 65%)` |
| Tertiary text | `--text-tertiary` | `rgb(255 255 255 / 45%)` |
| Focus ring | `--border-focus` | `rgb(153 206 255 / 72%)` |

Status colors are semantic: blue/accent for selection, green for proven readiness/success, orange
for warning, and red for blocking/fault/destructive action. Do not use green for a merely possible
platform capability.

### Type, shape, and motion

- UI font: system stack (`-apple-system`, BlinkMacSystemFont, Segoe UI, sans-serif).
- Monospace: system monospace stack for paths, codes, and diagnostics.
- Type scale: 11, 12, 14, 16, 18, 20, and 24 px.
- Radii: 4–16 px plus a fully rounded token. Use the smallest radius that matches component scale.
- Motion: 120–300 ms. State meaning must not depend on animation.
- Layout constants: 46 px toolbar, 275/56 px sidebar, 30 px navigation rows, 760 px primary content,
  and 900 px settings
  content.

## Layout anatomy

```text
┌───────────────────────────────────────────────────────────────┐
│ draggable titlebar / workspace status                         │
├──────────────────┬────────────────────────────────────────────┤
│ Persona Voice    │ page title + runtime state                 │
│ original mark    ├────────────────────────────────────────────┤
│                  │                                            │
│ Voice            │ centered task surface                      │
│ History          │ cards, rows, diagnostics, or settings      │
│                  │                                            │
│ Settings         │                                            │
└──────────────────┴────────────────────────────────────────────┘
```

The sidebar can collapse to an icon rail. The primary surface owns scrolling; the window root does
not. Settings use a secondary navigation column and a scrollable detail pane.

## Localization

The renderer ships complete English, Japanese, and Simplified Chinese catalogs. First run begins
with an explicit language step before the optional support and engine steps; locale is never guessed
from the host. All three catalogs must retain identical keys and placeholder contracts. Raw backend
diagnostic/error detail may remain unchanged, but every surrounding label, status, action,
confirmation, notice, and accessible name comes from the selected catalog. Missing locale keys fail
the build/test contract rather than falling back to English.

## Component patterns

- **Session card:** runtime truth, voice visualization, one primary Start/Stop action, and setup
  recovery when blocked.
- **Readiness row:** stage label, stable detail, and Ready/Blocked result backed by a capability
  probe.
- **Route row:** source, voice, and output values with explicit navigation affordance.
- **Settings row:** explanatory copy on the left, one bounded control on the right.
- **Notice:** inline and contextual; errors remain visible until state changes or the user acts.
- **Modal:** reserved for consequential confirmation such as Clear history; focus is trapped and
  returned.
- **Toast:** transient result only; never the sole carrier of a fault or permission requirement.

## Runtime language

| Runtime state | UI meaning |
| --- | --- |
| `stopped` | No route is owned; checks may be Ready or Blocked |
| `starting` | Readiness and engine preparation are in progress |
| `armed` | Source observed; original route remains unchanged |
| `engaging` | Suppression proved; converted output is being prepared |
| `running` | Converted pipeline accepts source frames |
| `stopping` | Ordered cleanup and route restoration in progress |
| `faulted` | Recovery requires explicit Stop; never show this as idle success |

Use “Blocked” for a missing stage, “Unsupported” for a deliberate platform exclusion, and
“Possible” only in technical planning copy. Avoid “Connected,” “Protected,” or “Private” unless the
underlying proof is precise enough to support it.

## Accessibility

- All icon-only controls require an accessible name and visible hover/focus feedback.
- Use native buttons, inputs, and selects; preserve keyboard operation and `:focus-visible`.
- Expose current navigation with `aria-current`, toggles with checked/pressed state, dialogs with
  modal labeling, and async notices through an appropriate live region.
- Text and status meaning must survive grayscale/color-vision differences; pair color with labels
  or icons.
- Maintain a 30 px minimum icon-button target in the dense desktop layout and larger targets for
  primary actions.
- Respect OS reduced-motion preferences when adding nonessential animation.
- Do not place interactive controls inside Electron drag regions.

## Extending the system

When adding a component:

1. reuse an existing semantic token or add one at the root with a documented role;
2. implement every runtime/disabled/error/focus state that can occur;
3. test expanded and collapsed sidebar layouts where relevant;
4. verify long process names, paths, translated voice names, and diagnostic text;
5. add keyboard and screen-reader semantics before visual flourish;
6. confirm no proprietary third-party asset entered the bundle.

Design changes that alter safety language or state representation require the same review as a
runtime contract change.

# Accessibility

Stellar SolarGrid targets WCAG 2.1 AA compliance across the dashboard and
payment flows.

## Keyboard navigation

- **Skip link**: a "Skip to main content" link is the first focusable element
  on every page (`frontend/src/app/layout.tsx`), jumping to each page's
  `#main-content` landmark.
- **Escape closes overlays**: the mobile nav menu and modals (see
  `useModalA11y`, used by `OfflinePaymentModal`) close on `Escape`.
- **Focus trap in modals**: `Tab`/`Shift+Tab` cycles only within an open
  modal's focusable elements, and focus returns to the triggering element on
  close (`frontend/src/hooks/useModalA11y.ts`).
- **Visible focus indicator**: a 3px, high-contrast `:focus-visible` outline
  is defined globally in `frontend/src/app/globals.css` so keyboard focus is
  always distinguishable from mouse hover.

## Screen reader support

- Interactive icon-only controls (theme toggle, wallet copy button, menu
  toggle, dismiss buttons) carry descriptive `aria-label`s.
- Toast notifications use `role="alert"` with `aria-live="assertive"`
  (`frontend/src/components/Toast.tsx`) so balance/payment updates are
  announced as they happen.
- Modals use `role="dialog"`, `aria-modal="true"`, and `aria-labelledby`
  pointing at their heading.
- Landmarks: `<nav aria-label="Main navigation">` and a single `<main>` per
  page.

## Testing

- Automated: run `axe-core` against each route in CI/local dev.
- Manual: verify with a keyboard only (no mouse) and with a screen reader
  (NVDA, JAWS, or VoiceOver) on the dashboard, pay, and history pages.

# 0028: The landing page and UI follow landingdesign.md

- Status: Accepted
- Date: 2026-11-16

## Context

The owner added `landingdesign.md`, a landing page method (one offer, one
audience, one action; a fixed page structure) and a strict visual system
(type scale and named text styles, a spacing table, flat backgrounds, an
allowed dark palette, Phosphor icons, one motion curve), and asked for the
landing page and the whole website to follow it. Where it differs from
`design.md`, the owner chose (2026-11-16):

- **the whole site** follows its copy rules: sentence case for headings and
  buttons, and no hyphens in visible text;
- **real facts only** as proof: the platform has no customers yet, so no
  testimonials or logos (and never invented ones);
- **no legal pages** (CLAUDE.md allows no new marketing pages), so the
  footer only links to pages that exist;
- **Phosphor icons**, bundled with the app.

## Decision

- **Landing page:** layout A (a classic hero with sections), because one
  request through the gateway explains the product. In order: a floating
  navigation bar; the hero (a two line heading with the white to grey text
  gradient, a subheading, one primary action, a proof line of true facts,
  and a panel showing a request passing through the gateway); problem to
  solution; five benefits; the tagline reveal (each word turns from muted
  to full colour as it crosses a line 60% down the screen, one
  IntersectionObserver, no scroll listener); how it works in three steps;
  proof from the project itself (tests, scanners, the unseal rule, no
  route returning a secret value); eight FAQ answers; a final call to
  action identical to the hero's; the footer. The old animated SVG
  diagrams, pointer glow, tilt cards and blur and clip effects are gone:
  the new rules allow only transform and opacity to animate.
- **Navigation:** a compact translucent bar floating off the top edge over
  a background blur; below 860px a menu button (two lines that turn into a
  cross) opens a full height panel whose links arrive 60ms apart.
- **Tokens (globals.css):** every font size snapped down to the Tailwind
  scale; named text styles `.heading-1` to `.caption-5`; every padding,
  margin and gap from the spacing table; dark surfaces `#181818`,
  `#1f1f1f`, `#272727` on `#000000`; buttons 8px by 12px; no background
  gradients (the wordmark is drawn flat); transitions on
  `cubic-bezier(0.22, 1, 0.36, 1)`, 300ms for colour and opacity, 500ms
  for position, 700ms for reveals; only transform and opacity animated
  (the chart sparklines now rise in instead of drawing their line).
  Headings use `text-wrap: balance`, body text `text-wrap: pretty`.
- **Copy:** every dashboard label, heading and button in sentence case;
  hyphenated words reworded (sign in, session lasts, write only, 1 to 64).
  Example values and code (`new-checkout`, `/v1/proxy/...`) and the
  `secure-cloud` wordmark are unchanged.
- **Theme:** the landing, log in and sign up pages follow the theme like
  the app (the owner's request after the first version): the switch in the
  dashboard's navbar (or the OS) decides, and the hero heading's gradient
  is black to grey in light and white to grey in dark (B5). The wordmark
  links to the landing page; the sidebar has "Back to workspaces" above
  its groups; new workspaces are made from a "Create workspace" dialog.
- **Ship items:** a favicon (`app/icon.svg`), page title, description and
  social sharing tags on the landing page, the skip link, and a check at
  390px for horizontal overflow (in the landing browser test).

## Consequences

- Most browser tests changed with the copy (button and heading names).
- `design.md` keeps the palette, feature accents and component shapes; a
  note at its top points here.
- Not done: FAQ structured data (an inline script would need the CSP
  nonce), an og:image, privacy and terms pages, cookie consent (only
  functional cookies are set).

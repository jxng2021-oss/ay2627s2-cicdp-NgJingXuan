# 0022: A HashiCorp-style UI, a landing page and split sign-in pages

- Status: Accepted (updates the look chosen in [0017](0017-dashboard-frontend.md))
- Date: 2026-11-15

## Context

`design.md` was replaced with a HashiCorp-inspired design reference: a
black canvas with charcoal surfaces, white primary buttons, eyebrow labels
above headings, 8px buttons and 12px cards, and one accent colour per
product. The owner also asked for a landing page with animations that catch
attention (which design.md doesn't describe), log-in and sign-up pages with
the form on the right and information about the platform on the left, and
navigation that is clearly organised.

## Decision

- **Palette:** HashiCorp's public palette, as tokens in `globals.css`.
  Each platform feature gets one product accent, used through
  `data-feature` (which sets `--feature` / `--on-feature`):
  secrets `#ffd814`, connections `#7b42bc`, files `#14c6cb`,
  audit `#00ca8e`, API keys `#1868f2`. Accents only fill small tiles,
  pills, icons and diagram details, never text on the page background, so
  contrast stays within WCAG AA (axe checks every page).
- **Type:** Geist Sans stands in for HashiCorp's own typeface (not
  licensed for us); Geist Mono is kept for in-product code, IDs and keys.
- **Themes:** the landing page and the log-in/sign-up pages are always dark
  (`.theme-dark`, design.md's marketing canvas). The app follows the OS
  setting: design.md only shows dark, so the light theme is our own,
  built from the same palette.
- **Structure:** a `(marketing)` route group holds the landing page at `/`
  (shown to everyone; signed in, the top bar has one "Open Dashboard"
  button that goes to `/workspaces`). `/workspaces` is a workspace
  picker: after logging in, people choose which of their workspaces to
  work in (they can belong to several), and the sidebar's "Switch
  Workspace" leads back to it. Only sign-up goes straight into the one
  workspace it just created.
  The `(auth)` group holds `/login` and `/sign-up`: the form on the right,
  highlights and a diagram on the left; on small screens the form comes
  first. The workspace sidebar is grouped (General, Access, Data,
  Monitoring, Manage) from one list in `src/lib/nav.ts`.
- **Motion (beyond design.md):** nothing loops. Every animation plays
  once (on load, when it scrolls into view, or when the visitor does
  something) and then rests on its final frame, and each part of the page
  moves in its own way:
  - hero: a scan line across the grid, a glow that follows the pointer,
    the headline's words coming into focus one by one, an accent
    underline drawn under the second sentence;
  - sections: a different entrance each (wipe, flip, slide, blur, zoom;
    `Reveal effect`), a light sweep across the closing banner;
  - stats: "0" counts down from 2048, "3 of 5" counts up, AES-256 and
    HMAC decode from random characters;
  - feature cards: tilt towards the pointer with a spotlight in the
    feature's colour; each icon has its own hover move;
  - "How it works": a line draws down the steps and each number lights up
    in turn; the terminal types itself;
  - three SVG diagrams drawn in code (`components/illustrations.tsx`)
    tell a short story once with a Replay button: the request picking up
    the key at the gateway, the 3-of-5 unseal, and the audit chain, which
    visitors can tamper with to watch the later links break.

  No images, no animation library, nothing loaded from elsewhere (the CSP
  stays strict). Under `prefers-reduced-motion` everything shows its final
  frame at once and pointer effects don't move anything. The diagrams are
  `role="img"` with a text description, and the tamper demo announces its
  result as text.

## Consequences

- One page more to keep accurate: the landing page only claims what the
  platform does (checked against the ADRs).
- The browser tests cover the landing page (visitor vs signed-in top bar,
  the mobile menu) and run axe on it, and wait for entry animations to
  finish before checking contrast.
- The demo shop keeps the earlier look; its `globals.css` is now a separate
  copy, not kept in sync.

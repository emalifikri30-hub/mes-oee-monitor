---
name: molca-ui-adopt
description: >-
  Add the Molca design system and @molca shadcn registry to an EXISTING
  Vite + React repo (e.g. a new mes-*-fe repo), then verify the theme matches
  @molca/molca-theme. Use when asked to register the @molca registry, adopt or
  migrate to Molca UI/theme, switch a repo to radix-nova, or check a repo's
  tokens against the kit. For building screens once Molca is set up, use
  `molca-ui`; for new prototypes use `molca-prototype`; for design specs use
  `molca-web-design-system`.
---

# Adopt Molca UI in an existing repo

This skill covers **setup and its traps**. The build rules (discover with the
CLI, semantic tokens only, the brand color flip, shared i18n, compose blocks)
live in the kit's own **`molca-ui`** skill. Load it when you start building
screens. It should be installed globally at `~/.agents/skills/molca-ui`, linked
from `~/.claude/skills/molca-ui`.

**Trap:** `shadcn add @molca/skill` ignores the `~` in the item's target and
writes to `<app>/.claude/skills/molca-ui/`, inside the repo. To update the
global copy, take `files[0].content` from
`https://molca-web-ui-kit.vercel.app/r/skill.json` and write it to
`~/.agents/skills/molca-ui/SKILL.md`. If an in-repo copy shows up, delete it
unless the team wants it committed.

Reference repos that already did this: `mes-master-data-fe-test` (first) and
`mes-portal-fe-test` (commits `5909a39` → `0dd01b5`). When unsure, copy what they
do.

Run every `shadcn` command from the app folder (`apps/web`), through the
package manager: `pnpm exec shadcn …`. Put new deps in the pnpm **catalog**
(`pnpm-workspace.yaml`) and reference them as `"catalog:"`.

## Step 1 — Register the registry

In `apps/web/components.json`:

```json
"registries": { "@molca": "https://molca-web-ui-kit.vercel.app/r/{name}.json" }
```

Check: `pnpm exec shadcn search @molca` lists the kit's items.

## Step 2 — Fix the CLI's path lookup (do this BEFORE any `add`)

**Trap:** the shadcn CLI reads only `tsconfig.json`. Vite templates put `paths`
in `tsconfig.app.json`, so the CLI can't resolve `@/` and writes files to a
literal `apps/web/@/` folder.

Fix: mirror the alias in `apps/web/tsconfig.json` (it compiles nothing itself):

```jsonc
{
  "files": [],
  "references": [{ "path": "./tsconfig.app.json" }, { "path": "./tsconfig.node.json" }],
  /* Mirrors tsconfig.app.json so the shadcn CLI (which only reads this file)
     resolves the `@/` aliases in components.json. Compiles nothing itself. */
  "compilerOptions": { "paths": { "@/*": ["./src/*"] } },
}
```

If an `apps/web/@/` folder already exists, move its files into `src/` and delete it.

## Step 3 — Switch the style to radix-nova

In `components.json`: `"style": "radix-nova"`, `"baseColor": "neutral"`,
`"iconLibrary": "lucide"`, `"cssVariables": true`.

Then **regenerate** every existing `components/ui/*` file so it matches the new
style. Use `@molca/<name>` where the kit has that item (button, alert), and plain
shadcn for the rest:

```bash
pnpm exec shadcn add @molca/button @molca/alert --overwrite
pnpm exec shadcn add card input label separator skeleton textarea --overwrite
```

**Trap:** radix-nova files import `cn` from the `cn` npm package. Rewrite those
imports to `import { cn } from "@/lib/utils";`. Don't add the `cn` package as a
dependency. Check with:

```bash
grep -rn "from ['\"]cn['\"]" src
```

Runtime deps the kit needs: `radix-ui` (the unified package), `@radix-ui/react-slot`
(for `@molca/button`'s `asChild`), `shadcn` (for `shadcn/tailwind.css`), and
`@fontsource/poppins`.

## Step 4 — Theme and fonts

`pnpm exec shadcn add @molca/molca-theme` writes the token blocks. Then check
`src/index.css` by hand:

- Imports, in order: `tailwindcss`, `tw-animate-css`, `shadcn/tailwind.css`, then the
  Poppins weights 400/500/600/700.
- **Trap:** the theme item `@import`s `https://molca-web-ui-kit.vercel.app/fonts.css`,
  which loads the display fonts from the kit's host. The reference repos self-host
  them instead. Copy `Molca-Bold.otf` and `Molca-Medium-alternative.otf` into
  `apps/web/public/fonts/` (take them from a reference repo). Declare them with
  `@font-face` as `"Molca Bold"` (700) and `"Molca Medium"` (500), and drop the
  remote import.
- Dark mode: `@custom-variant dark (&:is(.dark *));`, plus an inline script in
  `index.html` that adds `.dark` before first paint (reads `localStorage.theme`,
  then falls back to `prefers-color-scheme`). This stops a light flash on reload.
- Keep any existing repo-specific CSS (e.g. `#root` full height). Don't redefine
  Molca tokens anywhere else.

## Step 5 — i18n

Replace an app-global `i18next` setup with the kit's isolated instance:
`pnpm exec shadcn add @molca/i18n` (it lands in `src/lib/i18n.ts`; it needs
`i18next` and `react-i18next` in the catalog). Register the
app's own strings in **their own namespace** (`registerMessages("portal", { en, id })`),
and use `useTranslation("portal")`. Call `applyStoredLanguage()` once on mount.
One language switcher then drives the app and every Molca block.

## Step 6 — Align the UI

Follow `molca-ui` from here. Things the reference repos settled on that the
kit doesn't spell out:

- Header like master-data's app shell: page background, `border-b`, `h-14`,
  a compact language switcher (icon + flag + code), and an outline theme toggle
  that shows the current theme.
- An app or launcher icon tile uses `bg-primary` (black in light, lime in dark),
  with a hover ring in `brand`.
- Build cards and tiles from shadcn `Card` + `Badge` and `@molca/alert`, not
  hand-rolled `div`s.

## Step 7 — Verify

```bash
node ~/.agents/skills/molca-ui-adopt/scripts/verify-theme.mjs apps/web/src/index.css
```

It fetches the live `@molca/molca-theme` and compares every token in
`@theme inline`, `:root`, and `.dark`. It exits 1 on any missing or changed
token. Then run `vp check` and `vp test`, and open the app in both light and dark.

## Done when

- [ ] `shadcn search @molca` works, and there's no stray `apps/web/@/` folder
- [ ] No `from "cn"` imports; `components.json` style is `radix-nova`
- [ ] `verify-theme.mjs` reports all tokens match
- [ ] Molca fonts load from `/fonts/` (check the Network tab); no light flash on reload in dark mode
- [ ] App strings live in their own `@molca/i18n` namespace
- [ ] `vp check` and `vp test` pass

Record any new trap in this file. If it's a kit bug, it belongs upstream in
`molca-id/molca-ui`.

## Traps found adopting mes-oee-monitor and mes-job-schedule

- **Follow master-data for kit + tokens, not for theme persistence.** Master-data's toggle only flips `.dark` and forgets the choice on reload. It also has no pre-paint script and depends on `next-themes` without mounting `ThemeProvider`. Persist with `localStorage.theme` plus the `index.html` script in Step 4. Do not add `next-themes`.
- **Fonts may be missing even when CSS names them.** `styles.css` in master-data references `/fonts/Molca-*.otf`. Those files were absent from some checkouts. Copy `Molca-Bold.otf` and `Molca-Medium-alternative.otf` from a repo that has them (or the kit host) before dropping the remote `@import`.
- **CSS entry is not always `styles.css`.** OEE and Job Schedule keep `src/index.css`. Point `components.json` `tailwind.css` at the file the app already imports.
- **Domain tokens die when the theme item overwrites CSS.** Re-add `--oee-*` (OEE) or `--event` / `--event-fill` / `--event-ink` (Job Schedule) to `:root`, `.dark`, and `@theme inline`. `verify-theme.mjs` allows extra tokens.
- **Do not overwrite `components/ui` files the reference app does not have.** Leave `radio-group.tsx`, OEE's `tag-input.tsx` / `option-tag-input.tsx`, and Job Schedule's `multi-select.tsx`. After replacing `badge.tsx`, re-apply OEE's `action` variant.
- **i18n namespace is per app.** Master-data uses `appShell`. These apps use `oee` and `jobs`. Register only shell chrome (theme, language). Translating every screen string in the same pass drifts labels off the behaviour tests.
- **Keep one git copy of this skill.** Install globally at `~/.agents/skills/molca-ui-adopt`. The committed copy lives only in `mes-oee-monitor/.cursor/skills/molca-ui-adopt`. Do not copy it into Job Schedule or every new consumer.
- **`@molca/mes` is a private `git+ssh` package.** A machine without the deploy key cannot `pnpm install` the workspace. Stub it only for a local web install, then restore the specifier. Do not commit the stub.

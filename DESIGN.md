# Repowatch design

The visual and interaction contract for Repowatch v0.1. UI code builds to
this file. The tokens below are the source values; the reference CSS is
[`docs/design/shared/base.css`](docs/design/shared/base.css) and the chosen
mock is [`docs/design/a-ledger.html`](docs/design/a-ledger.html).

## Subject and job

- **Subject**: the working state of ~40 git repositories and worktrees on one
  Windows PC.
- **Audience**: one developer who switches between many projects and loses
  track of what is uncommitted, unpushed or unmerged.
- **The screen's single job**: answer "which repositories need me, and for
  what?" in one glance, then let me fix it without leaving the app.

## Directions explored

Three static mocks, same data, different composition. Each has a dashboard
and a repo detail view, rendered in light and dark at 1440x900 and 1024x700
by `npm run design:screenshots` into
[`docs/design/screenshots/`](docs/design/screenshots/).

| Direction | Composition | Screenshots |
| --- | --- | --- |
| **A. Ledger** (chosen) | One dense list grouped by attention, a coloured state rail per row and aligned count columns; detail in a split pane that keeps the list in view. | [dashboard](docs/design/screenshots/a-ledger-dashboard-light-1440x900.png), [detail](docs/design/screenshots/a-ledger-detail-dark-1440x900.png) |
| B. Triage lanes | Repositories as cards in columns by what they need (Fix first, Commit, Push or pull, Tidy up, Clean); detail in a drawer over the board. | [dashboard](docs/design/screenshots/b-lanes-dashboard-light-1440x900.png), [detail](docs/design/screenshots/b-lanes-detail-dark-1440x900.png) |
| C. Signal strip | A machine-wide summary bar, then one row per repository whose segmented strip encodes its states; detail as a full page. | [dashboard](docs/design/screenshots/c-signal-dashboard-light-1440x900.png), [detail](docs/design/screenshots/c-signal-detail-dark-1440x900.png) |

### Why A

1. **It fits the machine on one screen.** At 1440x900 compact density A shows
   18 repository rows plus their five group headers; C shows 15; B shows 4 to 7
   cards per lane and pushes the rest below the fold of each column.
2. **Counts scan vertically.** "What is unpushed?" is one glance down the `↑`
   column. In B the same fact is scattered across card chips; in C it moves
   with each strip's segment widths.
3. **It survives the small window.** At 1024x700 A keeps every count column
   and only drops "Last commit". B truncates repo and branch names on cards;
   C's strip segments collapse to icon plus number and lose their words.
4. **It acts without losing context.** The split pane keeps the list visible
   while you stage, commit or push, and the list narrows to a rail in the
   detail view instead of disappearing (except below 1200 px, where a back
   button returns to it).
5. **It is the most keyboard-shaped.** A single list with a selection maps
   directly to up/down, Enter and Escape; lanes need two-dimensional
   navigation and the full-page detail of C needs a page change per repo.

Borrowed from the others: B's plain-verb lane names became the filter and
group language ("At risk", "Uncommitted", "Out of sync", "Loose ends"); C's
summary bar became the counts in the filter chips rather than a separate band
(one fewer accessory).

Known weaknesses of A, to watch during implementation: the dashboard pane is
tight at 1024 wide (384 px), and long file paths truncate the folder before
the file name (deliberate: the file name always stays visible).

## Frontend-design guidance applied

From `frontend-design` SKILL.md:

- **Ground it in the subject.** The vocabulary is git's own: porcelain status
  letters (`A`, `M`, `?`) and `↑`/`↓` for ahead/behind as column heads,
  branch names and hashes in a monospace, diff hunks as `@@` lines.
- **Typography carries the personality.** Hanken Grotesk for the interface,
  Commit Mono (a monospace literally designed around commits and code) for
  every git fact. The pairing is the identity; there is no decorative display
  face.
- **Structure is information.** Group headers are the attention categories in
  severity order; columns are real counts; nothing is numbered for
  decoration.
- **Spend boldness in one place.** The signature is the rule *colour means
  state, nothing else*: the chrome is monochrome graphite, so the five state
  colours (rails, dots, labels) are the only colour on screen and read
  instantly.
- **Avoid the default looks.** Not warm cream with a serif, not near-black
  with one acid accent, not a broadsheet of hairlines: cool graphite neutrals,
  sans plus mono, and colour only where it means something.
- **Restraint and self-critique.** Every mock was screenshotted and fixed
  (truncated chips, wrapping tabs, ligatures in diffs, lost labels); C's
  separate summary band was removed in the final choice.
- **Quality floor.** Both themes follow the OS, visible focus, reduced motion,
  checked contrast, no horizontal overflow at 1024 wide.
- **Writing.** Actions say what happens and keep their name through the flow
  (`Push` → "Pushed 2 commits to origin/main"); errors say what is wrong and
  how to fix it ("Repository is locked: index.lock exists"); empty states
  invite the next step.

## Colour

Light and dark follow the OS (`prefers-color-scheme`); Settings can force
either. All values are hex so they can be checked; `npm run design:check`
verifies every text pair at **4.5:1 or more** and every state graphic at
**3:1 or more** against the backgrounds, in both themes.

### Neutrals

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `--bg` | `#f6f7f9` | `#0e1014` | Window background, filter bar, pane background |
| `--surface` | `#ffffff` | `#14171c` | Title bar, list, cards, inputs' container |
| `--surface-2` | `#f0f2f5` | `#1b1f26` | Hover, group headers, search field, segmented control |
| `--surface-3` | `#e6e9ee` | `#242932` | Selected row or file |
| `--border` | `#e1e5ea` | `#262b33` | Dividers, row rules |
| `--border-strong` | `#cbd1d9` | `#353b46` | Buttons, inputs, `kbd` |
| `--text` | `#14171c` | `#e8ebef` | Primary text (16.8:1 / 15.9:1 on bg) |
| `--text-2` | `#4a515c` | `#b4bbc6` | Secondary text, labels |
| `--text-3` | `#5b636f` | `#8c95a2` | Meta: branch, time, zero counts (≥ 5.4:1 on surface-2) |
| `--ink` / `--on-ink` | `#14171c` / `#ffffff` | `#e8ebef` / `#0e1014` | Primary button, selected tab underline, focus ring |
| `--danger` / `--on-danger` | `#b02e21` / `#ffffff` | `#f5918a` / `#0e1014` | Confirm button of a destructive action only |

### State colours (never colour-only)

Each attention category has a solid (rails and dots, ≥ 3:1), a text colour
(≥ 4.5:1 on every surface and on its tint) and a tint (chip background,
diff lines). Every coloured mark is paired with an icon and words, so the
state reads without colour.

| Category | Includes | Solid L / D | Text L / D | Tint L / D | Icon + words |
| --- | --- | --- | --- | --- | --- |
| At risk (`risk`) | scan error, conflicts, detached HEAD, lost commits | `#dd4a3a` / `#f0604f` | `#b02e21` / `#f5918a` | `#fce8e5` / `#351815` | alert / unlink / rewind + "Detached HEAD", "3 lost commits" |
| Uncommitted (`change`) | staged, modified, untracked | `#c47c06` / `#e9a23b` | `#8f520a` / `#f1b866` | `#fbf0dc` / `#2b2113` | plus / commit dot + "2 staged", "3 modified" |
| Out of sync (`sync`) | ahead, behind, no upstream, no remote | `#2f7fd8` / `#4c9af0` | `#1d5ca9` / `#86b9f5` | `#e3eefb` / `#14223a` | ↑ / ↓ / cloud-off + "2 to push", "No upstream" |
| Loose ends (`branch`) | branches not merged into default, stashes | `#8a5bd6` / `#a27cf0` | `#6a3db6` / `#c2a8f7` | `#efe8fb` / `#221a38` | branch / tray + "2 unmerged branches" |
| Clean (`clean`) | nothing to do | `#2e9e5b` / `#3fbf74` | `#1d7543` / `#6fd49a` | `#e3f4ea` / `#13261c` | check + "Clean" |

A repository's category is its most severe issue (risk > change > sync >
branch > clean); the row rail uses that colour, the state cell shows the most
severe issue's icon and text plus "+N" for the rest, and the count columns
show everything. Diff lines use `--diff-add` (`#e4f4ea` / `#11261a`),
`--diff-del` (`#fbe9e6` / `#31181a`) and `--diff-hunk` (`#eef1f6` /
`#18202c`) with `--text`, and a `+`/`−` sign column so additions and
deletions do not rely on colour.

## Type

| Role | Family | Size / line | Weight | Notes |
| --- | --- | --- | --- | --- |
| Repo title (detail) | Hanken Grotesk | 20 / 28 | 720 | letter-spacing −0.02em |
| Brand | Hanken Grotesk | 14 | 680 | |
| Body, rows, buttons | Hanken Grotesk | 13 / 19 (buttons 12.5) | 400 / 560 / 600 | names 600, selected 700 |
| Section and group labels | Hanken Grotesk | 11.5 | 650 | uppercase, +0.04em |
| Git facts: branches, hashes, paths, counts, `kbd` | Commit Mono | 11.5–12 | 400 / 600 | ligatures off |
| Diff | Commit Mono | 12 / 21 | 400 | ligatures off, `white-space: pre` |

- Fonts ship with the app (no network): `@fontsource-variable/hanken-grotesk`
  (latin, variable weight) and `@fontsource/commit-mono` 400 and 600, both
  SIL OFL 1.1. Fallbacks: `Segoe UI Variable Text, system-ui` and
  `Cascadia Mono, Consolas`.
- Numbers use tabular figures (`font-feature-settings: 'tnum'`) so counts
  align.

## Spacing and layout

- Base unit 4 px; spacing steps 2, 4, 6, 8, 10, 12, 16, 20, 24.
- Radii: 4 (`--radius-s`: kbd, refs), 6 (`--radius-m`: buttons, fields,
  lists), 10 (`--radius-l`: dialogs, palette). Pills (13 px) only for filter
  chips.
- Elevation: flat surfaces divided by 1 px borders; only floating layers
  (palette, dialog, menus, toasts) use `--shadow-pop`.
- Window frame, top to bottom: title bar 44, filter bar 40, main (list +
  pane), status bar 26.
- List: row 34 compact / 46 comfortable, group header 28 (sticky under the 30
  px column header). Columns: repository (≥150, 1.25fr) · state (≥120, 1fr) ·
  seven 34 px count columns (`A`, `M`, `?`, `↑`, `↓`, branch, stash) · last
  commit 92. Zero renders as a muted `·`.
- Pane: 440 px at ≥ 1200 wide, 384 px below. Detail view: list narrows to a
  264 px rail (name + state icon + count) and the pane splits into files
  (300 px, 260 below 1200) and diff.
- Below 1200 px wide: "Last commit" column and the lowest-priority filter
  chip hide; in the detail view the list hides behind a back button.
- Minimum window: 1024x700, the smallest size the mocks are verified at.

## Components

- **Title bar**: brand mark (ink square with an amber dot), search field that
  opens the command palette (`Ctrl K`), scan time in a polite live region,
  Rescan button, Settings icon button.
- **Filter chips**: toggle buttons with `aria-pressed`, a state dot and a
  count; "Needs attention" is the default. Density is a two-button segmented
  control (Compact / Comfortable).
- **Ledger row**: 3 px rail in the category solid; name (600) + worktree badge
  + branch (mono, `--text-3`; detached shows `HEAD <hash>`); state cell (icon
  + text in category text colour, "+N" in `--text-3`); count cells. Hover
  `--surface-2`, selected `--surface-3` and bold name. Rows are one roving
  tab stop.
- **Group header**: sticky, `--surface-2`, dot + uppercase label + count.
- **Detail header**: title, branch ref chip, sync ref chip ("↑ 2 to push"),
  path in mono, actions Fetch · Pull · **Push** (ink, with count) and icon
  buttons for VS Code, terminal and Explorer. On the dashboard the header also
  lists the repo's issues as rows, each with its action ("Commit", "Push",
  "Branches").
- **Tabs**: Changes · Branches · Stashes · Lost commits, each with a mono
  count; selected tab has a 2 px ink underline; `role="tablist"`.
- **File row**: status letter (mono 600, category text colour; `?` for
  untracked, as in `git status`), folder in `--text-3` that truncates before the file name,
  `+n −n`, stage/unstage icon button with an accessible name.
- **Diff viewer**: sticky file header with Stage file; hunk header row in
  `--diff-hunk` with Stage hunk; old/new line-number gutters, sign column,
  monospaced text that never wraps (horizontal scroll inside the diff only).
- **Commit box**: labelled message field, staged count, ink Commit button
  (disabled with a reason when nothing is staged or the message is empty).
- **Buttons**: default (surface + strong border), ghost (no border), ink
  (primary, one per area), icon-only (28 px, always with `aria-label`),
  danger (only inside confirmations).
- **Confirmation dialog** (all dangerous actions): `--radius-l`,
  `--shadow-pop`, title names the action ("Delete branch fix/runner-timeout?"),
  body states the exact consequence and how to undo it, buttons "Cancel"
  (focused first) and the action's own verb ("Delete branch") in `--danger`.
- **Command palette**: centred 560 px dialog, search input, results grouped
  (Repositories, Actions), keyboard hints in `kbd`.
- **Loading**: skeleton rows in `--surface-2` on first scan; on rescan the
  current list stays and a 2 px indeterminate bar runs under the column
  header.
- **Empty states**: no roots ("Choose folders to watch" + Add folder) and no
  repositories found ("No git repositories under these folders" + Edit
  folders). Error rows use the risk category with the git message.
- **Status bar**: watching state, root count, background fetch on/off, sort.
- **Tray**: monochrome icon with a numeric badge of repositories needing
  attention.

## Motion

Motion explains change; it never decorates.

| What | Duration | Easing | Static equivalent |
| --- | --- | --- | --- |
| Hover and press colour | 120 ms | `--ease` `cubic-bezier(0.2, 0, 0, 1)` | instant colour |
| Row state change after a scan (rail and state cell crossfade) | 180 ms | `--ease` | the new state is shown; the live region announces "forja: 2 to push" |
| Pane and tab content swap | none | — | instant |
| Palette, dialog, menu open | 140 ms opacity + 4 px rise | `--ease` | appears in place |
| Toast in / out | 180 ms opacity + 8 px slide | `--ease` | appears in place, stays 5 s |
| Rescan progress bar | 1.2 s loop | linear | static "Scanning…" text in the title bar |

With `prefers-reduced-motion: reduce` transitions are off (duration 0) and
every animation drops to 0.01 ms and runs once (no movement, no loops), the progress bar is replaced by its text and
toasts appear without sliding.

## Focus and keyboard

- Focus ring: `outline: 2px solid var(--ink); outline-offset: 2px` on
  `:focus-visible`, both themes (≥ 15:1). Inside the list and file rows the
  ring is inset (`outline-offset: -2px`) so scroll containers do not clip it.
  Focus is never hidden.
- Keys: `↑`/`↓` (or `j`/`k`) move the selection, `Enter` opens the detail
  view, `Esc` goes back or closes a layer, `Ctrl K` opens the palette, `/`
  focuses search, `Ctrl R` rescans, `1`–`4` switch detail tabs, `Space`
  stages or unstages the focused file.
- After a rescan, the selection and the search text stay; focus stays on the
  same repository if it still exists.

## Accessibility checklist

- State is never colour-only (icon + words + count columns with headers).
- Text pairs ≥ 4.5:1 and state graphics ≥ 3:1, checked by
  `npm run design:check` in both themes.
- Icon-only buttons have accessible names; count column heads have names
  ("Staged", "Ahead").
- Scan results and action outcomes are announced in a polite live region
  without moving focus.

## Implementation

The app builds to this contract in `src/`. Tokens are CSS variables in
`src/styles/tokens.css` (light by default, `data-theme="dark"` for dark, set
by `src/app/theme.ts` from the OS or from Settings); shared primitives are in
`src/styles/base.css`. `npm run test:ui` checks the built frontend against it
in Edge, both themes, at 1440x900 and 1024x700.

### Dashboard (task ui-dashboard)

`frontend-design` guidance applied:

- **Spend boldness in one place.** Colour stays state-only: the rail, state
  cell, group dot and filter chip dot use the category colours; buttons,
  chips, selection and focus are graphite.
- **Structure is information.** Groups are attention categories in severity
  order with real counts; sorting by name or last commit drops the groups
  rather than inventing new ones. Filter chips count every repository with a
  reason in that category (a repository with changes and commits to push
  appears under both "Uncommitted" and "Out of sync"), while the groups place
  it once, under its most severe category.
- **Ground it in the subject.** Column heads are git's own letters and
  arrows; zero is a muted `·`; branches, hashes and paths are Commit Mono.
- **Writing.** Empty and failure states say what happened and offer the next
  step ("Choose folders to watch" + Add folder; "No repository matches …" +
  Clear search; "Rescan failed. … The list shows the last good scan." +
  Retry). The dashboard pane explains each reason in one line ("Commits not
  on origin/main").
- **Restraint and self-critique.** Screenshots of every state were reviewed;
  the filter bar is hidden when there is nothing to filter, and the summary
  pane carries no git write actions (those belong to the detail view).
- **Quality floor.** One roving tab stop in the list, `/` focuses search,
  `Ctrl R` rescans, focus stays on the same repository through refreshes and
  regrouping, results are announced in a polite live region, reduced motion
  turns transitions off.

### Settings, command palette and keyboard (task ui-settings-palette)

`frontend-design` guidance applied:

- **Spend boldness in one place.** The palette is the one floating surface
  with the ink accent: a 2 px ink bar marks the highlighted option and an ink
  underline the focused field; repository options keep their state colour on
  the icon and state words only. Settings stays flat: bordered groups, no
  colour except the risk banner.
- **Structure is information.** Palette sections are real kinds of target
  (Repositories, Go to, Actions); with a query, the section with the best
  match comes first. Settings sections follow what the user controls (Watched
  folders, Skipped folders, Appearance, Remotes, Lost commits, Window), and
  the folder counts are real.
- **Writing.** Controls say what happens ("Stop watching C:\…", "Skip a
  folder", "Turn background fetch on"); background fetch states that it is
  read-only and never pushes or pulls; a failed save says why and that "Your
  change is still shown below", with Retry and Discard change; an invalid
  window says the allowed range.
- **Motion.** The palette and the shortcuts sheet open with the 140 ms
  opacity + 4 px rise; with reduced motion they appear in place (checked by
  `npm run test:ui`).
- **Restraint.** The palette offers only non-destructive commands and hides
  ones that would change nothing (the current filter, sort, theme, density);
  git write actions stay behind their confirmations in the repository view.
- **Quality floor.** `Ctrl K` palette (combobox + listbox,
  `aria-activedescendant`), `Ctrl ,` settings, `?` shortcuts sheet, `Esc`
  closes a layer and focus returns to where it was; every Tab stop shows a
  focus indicator; the palette announces its result count, scan results are
  announced in the app's polite live region without moving focus.

### Repository view (task ui-detail)

`src/features/detail/` and `src/components/ConfirmDialog.tsx`. Opened with
Enter or a double click on a row, or "Open repository" in the dashboard
pane; the ledger stays as a 264 px rail (name, state icon, count) so another
repository is one click away. Below 1200 px the rail hides and the back
button (or `Esc`) returns to the list.

`frontend-design` guidance applied:

- **Ground it in the subject.** Files carry their porcelain letter, the diff
  is git's own `@@` hunks with old/new gutters, branches, hashes, stash refs
  and paths are Commit Mono; Push carries the count it will send.
- **Spend boldness in one place.** One ink button per area (Push in the
  header, Commit in the commit box, the verb of a non-destructive
  confirmation); `--danger` appears only on the confirm button of Delete
  branch and Drop stash. Colour elsewhere is state only (diff add/remove,
  unmerged branch counts, lost-commit icons).
- **Writing.** Every action keeps its name through the flow: the button
  ("Push"), the pending line ("Pushing main to origin/main…"), the result
  ("Pushed 3 commits to origin/main" or "main was not pushed." followed by
  git's own text in mono). Confirmations name the target in the title
  ("Delete branch old/merged?"), state the consequence and the undo, and
  the disabled Commit says why ("Stage a file first.").
- **Restraint.** No force option, no reset, no amend, no "delete unmerged";
  only branches merged into the default branch show Delete. Lost commits are
  searched when the tab is opened, never during a scan.
- **Restraint and self-critique.** Screenshots of every tab, a pending
  action, a git error and a confirmation were reviewed in both themes at
  both sizes; fixes: git's stderr moved to its own line under the
  explanation, the new-branch field capped at 560 px, the commit hint
  shortened so it does not wrap in the 260 px file column.
- **Quality floor.** Tabs are a `tablist` (arrows, `1`–`4`), Space stages
  the focused file, `Ctrl Enter` commits, Cancel has focus first in every
  confirmation (the branch name field takes it in Recover), focus returns to
  the button that opened it; results of the shown repository are announced
  in the polite live region and held 1.5 s so a following refresh does not
  replace them. Diff lines and file names are rendered as text, never HTML.

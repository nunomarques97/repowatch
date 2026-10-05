# Decisions

Numbered record of product, design and technology decisions for Repowatch.
The Sponsor delegated product and design decisions for v0.1; each one is
recorded here with its reason.

## 1. Name: keep "Repowatch"

Date: 2026-10-04.

"Repowatch" was a working name. It was checked on 2026-10-04:

| Where                    | Result                                                                                                                                                                                                                     |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| crates.io                | `repowatch` does not exist. Free.                                                                                                                                                                                          |
| npm                      | `repowatch` is taken by an unrelated, inactive package (v0.0.3, "Repository live change and diff notification service", last modified 2022). Not a problem: Repowatch is not published to npm and its `package.json` is `private`. |
| GitHub                   | About 80 repositories match the name. The exact-name ones are small personal projects (5 stars or fewer), for example a GitHub-watchlist site, a package cache and a shell multi-repo monitor with 0 stars. None is an established product. |
| Existing apps            | No app named Repowatch in winget. No established desktop app with this name was found. The closest products (RepoZ, GitHub Desktop) have different names.                                                                 |
| Sponsor's GitHub remote  | The project remote is already `github.com/nunomarques97/repowatch`.                                                                                                                                                       |

Decision: keep **Repowatch**. No conflict blocks it, crates.io is free, and the
Sponsor already reserved the repository with this name. A rename would make
the repository name and the product disagree for no real gain.

Used as: product name `Repowatch`, npm package `repowatch` (private), app
crate `repowatch`, core crate `repowatch-core`, bundle identifier
`io.github.nunomarques97.repowatch`.

## 2. Frontend toolchain: TypeScript 6.0

Date: 2026-10-04.

TypeScript 7.0 is the latest release, but `typescript-eslint` 8.71 supports
TypeScript below 6.1 only. The project pins `typescript ~6.0.3` so lint and
typecheck use the same compiler. Revisit when `typescript-eslint` supports 7.

## 3. Cargo scripts load a complete MSVC environment when needed

Date: 2026-10-04.

On the development PC the newest Visual Studio (18 Community) is a partial
install without the x64 C runtime libraries, so `cargo` links fail with
`cannot open file 'msvcrt.lib'` even though Visual Studio 2022 Build Tools are
complete. Changing the system install is out of scope, so the npm scripts that
compile Rust (`tauri`, `lint:rust`, `test:rust`) go through
`scripts/msvc-env.mjs`. On Windows, when the newest installation lacks the CRT
libraries, it loads the `vcvars` environment of the newest complete one; in
every other case it runs the command unchanged. Plain `cargo` still works on
machines with a normal setup.

## 4. Visual direction: A, the Ledger

Date: 2026-10-04.

Three directions were mocked with the same data, as static HTML rendered in
light and dark at 1440x900 and 1024x700 (`docs/design/`, screenshots in
`docs/design/screenshots/`): A, Ledger (one dense list grouped by attention,
state rail and aligned count columns, split-pane detail); B, Triage lanes
(cards in columns by what each repository needs, detail drawer); C, Signal
strip (one row per repository with a segmented state strip, full-page
detail).

Decision: **A, Ledger**. It shows the most repositories at once (18 rows with
group headers at 1440x900, against 15 for C and 4 to 7 cards per lane for B),
lets counts be scanned down a column ("what is unpushed?" is the `↑` column),
keeps every count at 1024x700 where B truncates names and C's strips lose
their words, keeps the list in view while acting in the detail pane, and maps
directly to keyboard navigation. B's plain-verb category names and C's
summary counts were folded into A's filter chips.

The design rule that carries the identity: the chrome is monochrome and
**colour means state, nothing else**, always paired with an icon and words.
Full reasons, tokens and components are in [DESIGN.md](../DESIGN.md).

## 5. Interface fonts: Hanken Grotesk and Commit Mono, bundled

Date: 2026-10-04.

The interface uses Hanken Grotesk (variable) for text and Commit Mono for git
facts (branches, hashes, paths, counts, diffs), installed from npm as
`@fontsource-variable/hanken-grotesk` and `@fontsource/commit-mono`. Both are
SIL Open Font License 1.1, free, and are bundled with the app so nothing is
fetched at runtime. Cost to the installer is the three latin woff2 files (about
130 KB). Segoe UI Variable and Cascadia Mono are the fallbacks. System fonts
alone were the zero-cost alternative but made the mocks read as a generic
Windows utility; the pairing is the product's typographic identity.

## 6. Design checks drive the installed Edge through playwright-core

Date: 2026-10-04.

`npm run design:check` renders the mocks with `playwright-core` (Apache-2.0,
free) using the `msedge` channel, which drives the Microsoft Edge already on
the PC; `playwright-core` never downloads browsers. Output goes to the
git-ignored `.artifacts/design/`; `npm run design:screenshots` refreshes the
tracked copies in `docs/design/screenshots/`. The same dependency serves the
later UI and end-to-end checks.

## 7. Git write actions: allow-listed, never forced, hunk staging kept

Date: 2026-10-04.

The detail view's actions live in `crates/core` (`actions`, `diff`,
`validate`) and run the git CLI like the read path: no shell, inherited
`GIT_DIR`-style variables removed, no terminal prompt, no editor
(`GIT_EDITOR=:`). Every write command passes an allow-list
(`check_write_args` in `git.rs`) that fixes, per subcommand, the options it
may carry and the ones it must carry (`restore --staged`, `apply --cached`,
`merge --ff-only`, `switch --no-guess`). No force, `branch -D`, `reset`,
rebase, amend, `checkout`, `clean` or remote-deleting refspec can be built;
unit tests assert the refusals and an integration test traces every git
process the actions start (`GIT_TRACE`) to show none of them appears.

- Pull is `git fetch` of the upstream's remote followed by
  `git merge --ff-only --no-autostash`, not `git pull`, so a user's
  `pull.rebase` setting can never turn it into a rebase. A diverged branch
  fails with a typed `NotFastForward` error and nothing changes.
- Push sends only the current branch with an explicit
  `refs/heads/<b>:<upstream>` refspec (or sets `origin/<b>` as upstream);
  a rejected push is a typed `PushRejected` error.
- Branch deletion uses `branch -d` after checking the branch is merged into
  the default branch; the current and the default branch are refused.
- Caller values are validated before any command runs: branch names follow
  `git check-ref-format` and never start with `-`, object ids must be full
  hex, paths must stay inside the repository (no absolute, drive, `..`, `\`
  or `.git` parts) and are passed after `--` as `:(literal)` pathspecs, so a
  file named `-A` or `*.txt` is that file only. Commit messages go on
  standard input.
- Stage and unstage hunk are kept (not cut): the diff is read again and a
  hunk is applied with `git apply --cached` only when a hunk with the same
  content hash is still there; otherwise a typed `Stale` error asks for a
  refresh. Stashes are named by index and object id with the same check.
- Unstaging before the first commit restores from the empty tree
  (`restore --staged --source=<empty tree>`), since there is no HEAD.
- Hooks run as on the command line; Repowatch does not bypass them.

## 8. App backend: one IPC contract, discovered paths only, events plus debounce

Date: 2026-10-04.

The Tauri shell (`src-tauri/src/`) owns the IPC contract; the UI talks only to
`src/ipc` (`RepowatchClient`), implemented over Tauri (`tauri.ts`) and by an
in-memory mock (`mock.ts`, scenarios `default`, `empty`, `noRepos`, `many`,
`errors`, chosen with `?mock=` outside Tauri) that follows the backend's
rules.

- **Contract check.** A Rust test serializes one value of every IPC type and
  variant into `src/ipc/contract.generated.ts`, typed with `src/ipc/types.ts`;
  `npm run typecheck` fails on any drift. Regenerate with
  `REPOWATCH_UPDATE_CONTRACT=1 npm run test:rust`.
- **Authorization.** Every repository command accepts only a path string
  exactly equal to one reported by the last full scan (no prefix, case or
  `..` variants). Write actions do not overlap per working tree (`busy`), and
  the repository is read again after success and failure.
- **Least privilege.** Commands are declared in an ACL app manifest
  (`build.rs`); the only capability grants event listen/unlisten and the
  app's own commands, with no file system, shell, opener, window or plugin
  permissions. The CSP has no `unsafe-inline`/`unsafe-eval` and only the IPC
  origin for connections; `freezePrototype` is on.
- **Scans.** One worker thread reads repositories (up to 8 summaries in
  parallel); overlapping scan requests coalesce into one follow-up scan;
  snapshots carry an increasing `generation`. A full rescan also runs every
  10 minutes to find new repositories.
- **Change watching: file-system events, not polling.** Each working tree is
  watched recursively with the `notify` crate (CC0, free;
  ReadDirectoryChangesW on Windows), events in dependency/build folders and
  git's objects, logs and lock files are dropped, and changes are debounced
  (0.8 s quiet, 5 s at most) into a refresh of only the changed repositories.
  Polling was the alternative; it either misses working-tree edits or has to
  run `git status` on every repository each period.
- **Settings** are JSON in `%APPDATA%\io.github.nunomarques97.repowatch`
  (or `REPOWATCH_CONFIG_DIR`). Defaults: Desktop and Documents as roots,
  background fetch off (30 min when enabled), 30-day lost-commit window,
  system theme, compact density, close to tray. With `REPOWATCH_CONFIG_DIR`
  set the default roots are empty, so a test run never scans the user's
  repositories unless it names them. An unreadable file is kept as
  `settings.invalid.json`.
  An update is saved, applied (scanner, background fetch) and announced as
  the `settings` event in one step under a lock, so overlapping updates can
  never leave the running app or the UI on older settings than the file.
- **Background fetch** runs `git fetch --all` once per repository (shared by
  its worktrees), first after 2 minutes, then every interval, only while
  enabled, with `GCM_INTERACTIVE=never` so it never opens credential windows.
  It has no code path to push, pull or move a branch.
- **Tray**: the icon is drawn in code (monochrome mark, red pill with the
  count, "9+" above nine), with a tooltip and an Open / Rescan / Quit menu.
  Closing the window hides it to the tray (setting `closeToTray`).
- **Folder picker** uses `tauri-plugin-dialog` (MIT/Apache-2.0, free) called
  from the Rust `pick_folder` command only; the webview gets no dialog
  permission.
- **Open in**: VS Code through `code` on `PATH` (path after `--`), Windows
  Terminal (`wt -d .` with the repository as working folder, so `;` in a path
  is never parsed) or a new `cmd` console, and Explorer; no shell is used.

## 9. Dashboard UI: state ownership, filters, search

Date: 2026-10-05.

- **One owner for scan results.** `src/app/scan-state.ts` is a reducer fed by
  the initial read, scan results and `snapshot` events; only a higher
  `generation` replaces the list, so a slow or stale result never overwrites
  a newer one. A failed rescan keeps the last good list with a Retry banner.
- **Filters count any reason in a category**, groups use the most severe one
  (see DESIGN.md, Implementation). "Needs attention" is the default filter;
  sort is by attention (grouped), name or last commit (ungrouped).
- **Search filters the list in place** (name, path, current and unmerged
  branches, worktree branches). The command palette (`Ctrl K`) is a separate
  task and does not replace it.
- **Settings screen starts minimal**: theme override, density and the watched
  folders (read only). Editing folders, exclusions, background fetch and the
  lost-commit window comes with the full settings screen.
- **Lost commits on the dashboard** are counted on demand from the summary
  pane ("Check for lost commits"), following decision 8's on-demand rule;
  recovery lives in the repository detail view.
- **Reduced motion turns transitions off** (duration 0, not 0.01 ms): a
  0.01 ms duration still animates every property, because
  `transition-property` defaults to `all`.

## 10. Settings, command palette and keyboard

Date: 2026-10-05.

- **Settings save each change at once**, like the rest of the app (no Save
  button). The settings screen shows the edited values until the backend
  confirms them (`src/features/settings/draft.ts`); a failed save keeps them
  on screen, also after leaving Settings, with Retry and Discard change. Only
  the latest save's result counts. The app's own settings revert to the last
  values the backend confirmed, so the dashboard never shows unsaved values
  as saved. The alternative, a form with a Save button, needs an
  "unsaved changes" prompt on every way out and was rejected as heavier.
- **The lost-commit window is a number field** (1–365 days) saved on Enter or
  when it loses focus, and only when valid; the fetch interval is a list of
  15 min to 4 h (the backend accepts 5–1440 minutes).
- **The palette is a native `<dialog>`** opened with `showModal()`: the
  browser keeps focus inside and makes the window inert, with no focus-trap
  code. Choosing a repository shows it on the dashboard, selected and
  focused, widening the filter or clearing the search when they would hide
  it; the repository view (task ui-detail) can make it open there instead.
- **The palette offers only non-destructive commands:** repositories,
  screens, rescan, add a folder, search, filters, sort, theme, density,
  background fetch on/off and opening the selected repository in VS Code, the
  terminal or Explorer. Branch, stash, commit, push and pull actions are not
  in the palette.
- **The dashboard's filter, sort and selection moved to the app frame**, so
  the palette can change them and they survive a visit to Settings.

## 11. Repository view: one action per repository, results stay with their repository

Date: 2026-10-05.

- **The repository view replaces the dashboard's summary pane** and keeps
  the list as a narrow rail (hidden below 1200 px), rather than opening as a
  separate full page: switching between repositories is the common move
  when clearing a backlog.
- **Action state lives per repository above the view**
  (`src/features/detail/activity.ts`). At most one action runs in a
  repository; a second click, Enter or a repeated confirm while it runs does
  nothing. A result is written to the repository that started it, so leaving
  a repository while its push runs never changes the one now shown, and
  coming back shows how it ended. After every action, success or failure,
  the view reads the repository again (status, branches, stashes, diff).
- **Detail, diff and lost-commit reads are scoped to their target**
  (`useLoad.ts`): a response for a repository, file or window that is no
  longer shown is dropped.
- **Confirmations**: push, delete branch, apply stash, drop stash and
  recover commit ask first, naming the target. Stage, unstage, commit, fetch,
  pull (fast-forward only, nothing is lost if it fails), create and switch
  branch run directly; switch is refused by git if it would overwrite
  changes. Opening in VS Code, the terminal or Explorer runs directly.
- **Hunk staging is kept** (decision 7): Stage hunk and Unstage hunk in the
  diff header of each hunk; line-level staging is out of scope for v0.1.
- **Git error text is shown verbatim** under the app's one-line explanation,
  so the user sees what git said; it is rendered as text.

## 12. End-to-end run: the release app on fixtures, through WebView2's own switches

Date: 2026-10-05.

- **`npm run e2e` drives the real release binary**, rebuilt first when any
  source is newer (`tauri build --no-bundle`). It launches
  `target/release/repowatch.exe` with `REPOWATCH_CONFIG_DIR` set to a
  temporary folder whose settings name only a fresh fixture set (decision 8),
  git's configuration isolated to the fixtures, and WebView2's documented
  variables `WEBVIEW2_USER_DATA_FOLDER` (temporary) and
  `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` (`--remote-debugging-port` on a
  free local port). The app has no test hook of its own: the shipped binary
  behaves exactly as tested. Playwright attaches over that port.
- **Real window sizes.** The window is resized through Win32 calls
  (PowerShell, nothing installed) until the page measures exactly 1440x900
  or 1024x700, rather than emulating a viewport. It is closed as a user
  would (`WM_CLOSE`; close-to-tray is off in the test settings) and stopped
  by force only if it does not quit.
- **Flows are verified with git, not only on screen**: stage and commit,
  push to the bare remote (Cancel first, then Push), fetch then
  fast-forward-only pull, a refused pull on a diverged branch, create,
  switch and delete a branch, apply and drop a stash, recover a lost commit
  to a named branch. Every write happens in the temporary fixture folder.
- **Screenshots** (`docs/screenshots/`, 7 screens x 2 themes x 2 sizes) are
  regenerated by every run and checked for completeness and size. They show
  the fixture names and temporary paths. Settings is opened with the mouse
  for its picture; keyboard focus on its heading is covered by `test:ui`.
- **Review against DESIGN.md.** Fixed: WebView2 drew the classic Windows
  scrollbars with arrow buttons; scrollbars are now thin and themed (thumb
  `--text-3` at 65 %, about 3:1). Left as is: the empty state still shows
  "Scanned just now · 0.0 s" and the Rescan button with no folders, and the
  settings heading shows the focus ring after keyboard navigation, as the
  focus rule requires.
- **Tray, verified and noted.** Windows 11 puts a new app's icon in the
  hidden-icons flyout. The run finds it with UI Automation (opening and
  closing the flyout when needed) and checks that its tooltip carries the
  scan's count, for example "Repowatch: 29 repositories need attention". The
  flyout cannot be captured as a picture (the shell draws it outside GDI),
  so there is no tray screenshot.
- Tauri still creates its default per-user data folder
  (`%LOCALAPPDATA%\io.github.nunomarques97.repowatch`) when it is missing;
  WebView2 writes to the temporary folder instead, so nothing is stored
  there during the run.

## 13. Performance: measured on fixtures, one read-only real scan, no tuning needed

Date: 2026-10-05.

Results and method: [PERFORMANCE.md](PERFORMANCE.md).

- **What is measured, and how.** Scan time uses `repowatch-bench`
  (`crates/core/src/bin/`), which calls only the core read path (discovery
  plus the dashboard summary on up to 8 threads, as the app's scanner) on 50
  fixture repositories in the OS temp folder; `npm run bench:check` fails over
  5 s. Cold start and idle memory are measured on the release app with the
  same fixtures, a temporary settings folder and a new WebView2 profile per
  launch. The dashboard sets a local performance mark,
  `repowatch:dashboard-painted`, after its first rows are drawn; the measuring
  script reads it over WebView2 remote debugging. The mark never leaves the
  page and costs nothing at run time.
- **The real repositories were read once.** The Desktop and Documents
  folders were scanned once by hand with the same read-only tool (no fetch,
  no optional locks, no writes): 67 repositories and worktrees in 1.83 s.
  Repository names from that scan are not recorded.
- **Memory is reported as private working set** (Task Manager's "Memory"),
  summed over the app and its WebView2 processes: 101 MB idle, of which the
  app process is 5.4 MB. The summed plain working set (382 MB) counts shared
  pages once per process and would mislead.
- **No tuning applied.** Every number is within its target (scan 1.1 s
  against 5 s; installer 1.5 MB against 15 MB). Cheap improvements found and
  left for later:
  1. A summary starts 3 to 6 git processes per repository (`status`,
     `remote` and `for-each-ref` always, plus one for merge
     counts when there are other branches; `log -1` on a detached HEAD;
     `worktree list` when worktrees exist). Reading remote names from the same
     `for-each-ref` run (or from the repository's config file) would save
     one start per repository. Not done: it changes tested parsing for a
     scan that is already well within its limit.
  2. Discovery of the real folders took 423 ms of the 1.83 s; a user who adds
     large non-code folders as roots can exclude them in Settings.
  3. WebView2 is about 95 % of idle memory. Its process model is the
     runtime's; no cheap and safe switch reduces it without hurting
     rendering, so it is left as is.

## 14. Technology choices for v0.1

Date: 2026-10-05.

The stack was fixed in the brief (Tauri 2, Rust, React + TypeScript + Vite,
the git CLI); the choices made inside it are listed here in one place. Every
dependency is free and open source; nothing in the build or the app needs a
paid service or an account.

| Area                | Choice                                                         | Licence                   | Why                                                                                                                                                                    |
| ------------------- | -------------------------------------------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Desktop shell       | Tauri 2 with the system WebView2                               | MIT / Apache-2.0          | Small installer and low memory, where Electron ships Chromium with every app. Decided in the brief.                                                                    |
| Git access          | The git CLI, parsing porcelain v2 and `for-each-ref` formats   | GPL-2.0 (run, not linked) | Same results, hooks, credentials and configuration as the user's command line. libgit2 and gitoxide were not used: they differ from git in edge cases and credentials. |
| Core library        | `crates/core`, depending only on `serde`                       | MIT / Apache-2.0          | Testable and benchmarkable without Tauri.                                                                                                                              |
| File watching       | `notify` 8 (ReadDirectoryChangesW on Windows)                  | CC0-1.0                   | Events instead of polling (decision 8).                                                                                                                                |
| Folder picker       | `tauri-plugin-dialog`, called from Rust only                   | MIT / Apache-2.0          | A native dialog without giving the webview a dialog permission (decision 8).                                                                                           |
| Settings folder     | `dirs` 7                                                       | MIT / Apache-2.0          | The per-user application data folder on every platform.                                                                                                                |
| Frontend            | React 19, TypeScript 6.0, Vite 8                               | MIT / Apache-2.0 / MIT    | Decided in the brief; TypeScript pinned to 6.0 (decision 2). No UI kit or CSS framework: components are built to DESIGN.md in plain CSS.                              |
| Fonts               | Hanken Grotesk and Commit Mono, bundled                        | OFL-1.1                   | The typographic identity, nothing fetched at run time (decision 5).                                                                                                    |
| Unit tests          | Vitest; `cargo test` on generated fixture repositories         | MIT / MIT, Apache-2.0     | Vitest shares Vite's configuration; the fixtures cover every git state ([CONTRIBUTING.md](../CONTRIBUTING.md#fixture-repositories)).                                   |
| Lint                | ESLint with typescript-eslint, `rustfmt`, `clippy -D warnings` | MIT / MIT, Apache-2.0     | The standard tools of each language.                                                                                                                                   |
| Browser checks, e2e | `playwright-core` driving the installed Edge and WebView2      | Apache-2.0                | No browser download; the e2e run attaches to the real release app (decisions 6 and 12).                                                                                |
| Installer           | NSIS through the Tauri bundler, per user, unsigned             | zlib (NSIS)               | Decision 15.                                                                                                                                                           |

## 15. Installer: unsigned per-user NSIS, WebView2 not bundled

Date: 2026-10-05.

- **NSIS rather than MSI.** The NSIS installer is small (1.5 MB), installs
  for the current user without an administrator prompt
  (`installMode: currentUser`) and shows the MIT licence. The WiX MSI that
  Tauri builds installs for all users and needs administrator rights.
- **WebView2 is not bundled.** Windows 11 includes it; on an older Windows the
  installer's default bootstrapper downloads Microsoft's runtime. Bundling
  the offline runtime would add over 100 MB.
- **Unsigned.** Code signing needs a paid certificate or acceptance into a
  free signing programme for open-source projects; both are Sponsor
  decisions (listed in [REPORT-PT.md](REPORT-PT.md)). Until then SmartScreen
  warns on the first run; [BUILD.md](BUILD.md) explains how to proceed and how
  to check the file's SHA-256.
- The installer was built and verified by reading it
  (`npm run verify:installer`); it was not run on the development PC.

## 16. Scope cuts for v0.1

Date: 2026-10-05.

What the brief asked for and v0.1 does not do, or does in a narrower form,
each with its reason.

1. **Line-level staging.** Files and hunks can be staged and unstaged; single
   lines cannot. Hunks cover the common case; line selection needs a much
   larger diff component (decision 11).
2. **Pull is fast-forward only, with no other mode.** The brief asked for
   fast-forward "by default"; v0.1 offers no merge or rebase pull at all. A
   diverged branch is reported and left to the command line, because a
   merge pull can stop in conflicts and a rebase rewrites commits.
3. **Push sends the current branch only**, never other branches or tags, and
   never with force (brief rule).
4. **Only merged branches can be deleted**, never the current or default
   branch and never a remote branch: deleting an unmerged branch loses work.
5. **Stashes can be applied and dropped, not created or popped.** The brief
   asked to list, apply and drop. Pop is apply then drop, which the user can
   do in two confirmed steps.
6. **No discarding of working-tree changes, and no reset, amend, rebase,
   merge, cherry-pick or conflict resolution.** These throw work away or
   rewrite history (brief rule). Conflicts are shown as "at risk" and are
   resolved in an editor or on the command line.
7. **No commit history view.** The dashboard and the repository view show the
   last commit, unmerged commit counts and lost commits; a log browser is a
   separate feature.
8. **No clone, init, remote editing, tags or submodule view.** Submodules
   belong to their parent repository and are not listed on their own.
9. **The command palette has only non-destructive commands** (decision 10).
   Branch, stash, commit, push and pull actions live in the repository view,
   where the dangerous ones confirm.
10. **Lost commits are checked on demand per repository**, not during the
    scan, to keep the scan of about 40 repositories fast (30 days by
    default, 1 to 365 in Settings).
11. **Background fetch only fetches.** It never pulls, merges or pushes and
    never opens a credential window; a repository that needs credentials is
    left until the user fetches it by hand.
12. **No start at login, no automatic updates, no installer signing**
    (decision 15). An update check would be a network call the privacy rule
    does not allow without a decision.
13. **Only Windows is tested.** The code is kept cross-platform (opening a
    terminal or the file manager has macOS and Linux variants), but macOS and
    Linux builds were neither built nor tested.
14. **No tray screenshot.** Windows draws the hidden-icons flyout where it
    cannot be captured; the tray is verified with UI Automation instead
    (decision 12).
15. **English only.** The interface is not localised.

## 17. Documentation: fixtures in pictures, links checked offline

Date: 2026-10-05.

- **README screenshots come from the end-to-end run** (`docs/screenshots/`,
  decision 12), so they show the generated fixture repositories and
  temporary paths, never real project names.
- **`npm run verify:docs`** (`scripts/verify-docs.mjs`) checks every local
  link and image in README, CONTRIBUTING, DESIGN and the documents in
  `docs/`: a relative path inside the repository, the exact letter case
  (GitHub is case-sensitive, Windows is not), not ignored by git, alt text on
  images, and `#fragment` anchors against the target's headings. Web links
  are counted but never requested, so the check needs no network. It runs as
  part of `npm run check`, and its parser has unit tests.
- **The Sponsor's report is in European Portuguese**
  ([REPORT-PT.md](REPORT-PT.md)); everything else is in English, as the brief
  requires.

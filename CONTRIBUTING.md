# Contributing to Repowatch

Thank you for helping. This page covers setting up a development machine, the
scripts, the fixture repositories every test uses, and the safety rules that
keep tests away from real repositories.

Code, comments, commit messages and documentation are in English. Product,
design and technology decisions are recorded in
[docs/DECISIONS.md](docs/DECISIONS.md); the visual contract is
[DESIGN.md](DESIGN.md). Read both before changing behaviour or the interface.

## Setup

Requirements:

- Rust 1.85 or newer (MSVC toolchain on Windows), with `rustfmt` and `clippy`.
- Node.js 22.12 or newer.
- git on `PATH`. Version 2.41 or newer is recommended; older versions use a
  slower path to count unmerged commits.
- On Windows: Visual Studio 2022 Build Tools with "Desktop development with
  C++", the WebView2 runtime (built into Windows 11) and Microsoft Edge (used
  by the browser checks; nothing else is downloaded).

```sh
npm install
npm run tauri dev
```

`npm run dev` serves only the frontend at `http://localhost:1420` with an
in-memory mock instead of the Rust backend. Pick a mock scenario with
`?mock=default`, `?mock=empty`, `?mock=noRepos`, `?mock=many` or
`?mock=errors`.

The npm scripts that compile Rust go through `scripts/msvc-env.mjs`, which
loads a complete Visual Studio environment when the newest installation is
partial (see decision 3 in [docs/DECISIONS.md](docs/DECISIONS.md)). Plain
`cargo` works on a normal setup.

## Scripts

| Script                     | What it does                                                                 |
| -------------------------- | ---------------------------------------------------------------------------- |
| `npm run check`            | Everything below marked ✓, in order. Run it before every pull request.       |
| `npm run lint` ✓           | ESLint on the frontend and scripts, zero warnings                            |
| `npm run lint:rust` ✓      | `cargo fmt --check` and `cargo clippy -D warnings`                           |
| `npm run typecheck` ✓      | TypeScript project check, including the IPC contract                         |
| `npm test` ✓               | Vitest unit tests (frontend and scripts)                                     |
| `npm run test:rust` ✓      | Rust unit and integration tests on fixture repositories                      |
| `npm run verify:docs` ✓    | Every local link and image in the docs resolves (no network)                 |
| `npm run test:ui`          | The built frontend with the mock IPC in Edge: behaviour, keyboard, contrast  |
| `npm run e2e`              | The release app on fixtures: scan, git actions, tray, screenshots            |
| `npm run design:check`     | The static design mocks in `docs/design/`: errors, overflow, contrast        |
| `npm run bench:check`      | Scan time of 50 fixture repositories, fails over 5 s                         |
| `npm run bench -- --app`   | Cold start and idle memory of the release app                                |
| `npm run build:installer`  | The NSIS installer ([docs/BUILD.md](docs/BUILD.md))                          |
| `npm run verify:installer` | Checks the installer without running it                                      |

Browser checks (`test:ui`, `e2e`, `design:check`) drive the installed
Microsoft Edge or the app's WebView2 through `playwright-core`; they never
download a browser. Their output goes to the git-ignored `.artifacts/` folder.
`npm run e2e` also rewrites the tracked screenshots in `docs/screenshots/`;
commit them only when the interface changed on purpose.

The IPC contract between Rust and TypeScript is checked twice: a Rust test
fails when `src/ipc/contract.generated.ts` (one value of every IPC type) is
out of date, and `typecheck` fails when that file no longer matches
`src/ipc/types.ts`. After changing an IPC type in Rust, update
`src/ipc/types.ts` and regenerate the file:

```sh
REPOWATCH_UPDATE_CONTRACT=1 npm run test:rust
```

(In PowerShell: `$env:REPOWATCH_UPDATE_CONTRACT=1; npm run test:rust`.)

## Fixture repositories

Tests never use real repositories. `scripts/make-fixtures.mjs` builds a set
of throwaway repositories that covers every state Repowatch shows: clean;
staged, unstaged, untracked and conflicted changes; ahead, behind, diverged;
no upstream, upstream gone, no remote; detached HEAD; unmerged branches;
stashes; linked worktrees; lost commits (deleted branch, hard reset,
dangling, older than the window); an empty repository; `main`, `master` and
no default branch; odd file names; and a broken repository. Remotes are
local bare repositories, so nothing touches the network.

```sh
node scripts/make-fixtures.mjs                    # a new folder in the OS temp folder
node scripts/make-fixtures.mjs --count 50         # at least 50 repositories
node scripts/make-fixtures.mjs --out <temp dir>   # a chosen folder inside the OS temp folder
```

It prints the folder and writes `fixtures.json` there, describing every
repository and the state it was built for. The Rust tests, `e2e` and `bench`
create their own set and remove it afterwards.

To look at the fixtures in the app, point it at a temporary settings folder
so it never reads your own settings or repositories:

```powershell
$env:REPOWATCH_CONFIG_DIR = "$env:TEMP\repowatch-dev-config"
npm run tauri dev
```

With `REPOWATCH_CONFIG_DIR` set, the default watched folders are empty; add
the fixtures' `repos` folder in Settings.

## Safety rules

These rules protect contributors' own work. A change that breaks one of them
is not accepted.

1. **Never run a test, script or app action on a real repository.** Write
   actions (stage, commit, push, pull, branches, stashes, recovery) are
   exercised only on fixture repositories. The fixture script refuses any
   target outside the OS temp folder and runs git with an isolated
   configuration (no system or global config, `GIT_CEILING_DIRECTORIES`).
2. **Run the app under test with `REPOWATCH_CONFIG_DIR`** pointing at a
   temporary folder, as `e2e` and `bench` do, so it neither scans your
   folders nor changes your settings.
3. **Reading stays read-only.** Status reads use `--no-optional-locks` and
   never fetch. `npm run bench -- --real` is the only script that reads real
   folders, and it only reads.
4. **No new network access.** The app makes no network calls except git
   operations the user triggers and the optional background fetch. No
   telemetry, analytics, update checks or web fonts.
5. **Git actions stay safe.** Every write command goes through the
   allow-list in `crates/core/src/git.rs` (`check_write_args`). Never add
   force-push, `branch -D`, `reset`, rebase, amend, `clean` or anything else
   that rewrites history or discards work. Dangerous actions confirm in the
   interface and name their target.
6. **Validate every value from the interface** in Rust before it reaches git
   (branch names, object ids, paths inside the repository), and pass paths
   after `--`.
7. **Never commit credentials.** `.gitignore` covers `.env*`, keys and files
   with `token` or `secret` in the name; keep it that way.

## Pull requests

- Keep a change focused, with tests: Rust tests on fixtures for the core and
  backend, Vitest for frontend logic, `test:ui` for interface behaviour.
- Interface changes follow [DESIGN.md](DESIGN.md) and include screenshots in
  light and dark at 1440x900 and 1024x700.
- A new product, design or technology decision gets a numbered entry in
  [docs/DECISIONS.md](docs/DECISIONS.md) with its reason.
- `npm run check` must pass.

By contributing you agree that your contribution is licensed under the
[MIT licence](LICENSE).

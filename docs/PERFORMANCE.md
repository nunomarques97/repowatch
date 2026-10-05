# Performance

How fast Repowatch scans, starts and how much memory it uses, how each number
is measured, and how to measure it again. All measurements use
`scripts/bench.mjs`.

## Results

Measured on 2026-10-05, release build of v0.1.0.

Machine: Windows 11 Home (build 26200), Intel Core i5-14400F (16 logical
processors), 32 GB RAM, NVMe SSD, git 2.53.0.windows.2, WebView2 runtime
154.0.4258.53.

| Measurement                                        | Result                                         |
| -------------------------------------------------- | ---------------------------------------------- |
| Scan, 50 fixture repositories (5 scans)            | median 1.11 s, slowest 1.30 s (limit: 5 s)     |
| Scan, real folders of this PC (once, read-only)    | 67 repositories in 1.83 s                      |
| Cold start to first paint (5 launches)             | median 645 ms                                  |
| Cold start to dashboard with 50 repositories       | median 1.20 s (1.16 s to 1.32 s)               |
| Idle memory, app + WebView2 (private working set)  | 101 MB (app process alone: 5.4 MB)             |
| Release executable (`repowatch.exe`)               | 4.0 MB                                         |
| Installer (`Repowatch_0.1.0_x64-setup.exe`, NSIS)  | 1.5 MB                                         |

### Scan details

Fixtures, five consecutive scans of the same 50 repositories (8 threads):

| Scan | Total   | Discovery | Summaries |
| ---- | ------- | --------- | --------- |
| 1    | 994 ms  | 52 ms     | 942 ms    |
| 2    | 971 ms  | 9 ms      | 961 ms    |
| 3    | 1.30 s  | 7 ms      | 1.29 s    |
| 4    | 1.26 s  | 90 ms     | 1.17 s    |
| 5    | 1.11 s  | 33 ms     | 1.08 s    |

The fixture set covers every state the dashboard shows (conflicts, stashes,
worktrees, unmerged branches, a broken repository, and so on); 44 of the 50
need attention and one is deliberately unreadable.

Real folders: the user's Desktop and Documents (the app's default roots),
scanned once: discovery 423 ms, summaries 1.40 s, 67 repositories and linked
worktrees, none unreadable. The slowest single repository took 354 ms; the
ten slowest took 217 ms to 354 ms each.

### Memory details

Idle memory was read 30 s after launch, with the 50 fixture repositories on
screen, as the median of three readings 2 s apart:

| Process                          | Private working set | Private bytes |
| -------------------------------- | ------------------- | ------------- |
| `repowatch.exe` (the app)        | 5.4 MB              | 8.3 MB        |
| WebView2, 6 processes together   | 96.0 MB             | 185.9 MB      |
| Total                            | 101.4 MB            | 194.2 MB      |

WebView2 (browser, GPU, network, storage and renderer processes) is about
95 % of the total. Private working set is the "Memory" column of Task
Manager. The summed plain working set (382 MB) counts pages shared between
the WebView2 processes once per process, so it overstates real use and is not
reported in the table.

## Method

### Scan time

`npm run bench` (and `npm run bench:check`):

1. Builds `repowatch-bench` (`crates/core/src/bin/repowatch-bench.rs`) in
   the release profile. The tool uses only the core read path:
   `repowatch_core::discover` plus `repowatch_core::summarize` for every
   repository on up to 8 threads, as the app's scanner does. Every git
   command runs with `--no-optional-locks`, `core.fsmonitor=false` and
   `GIT_NO_LAZY_FETCH=1`; nothing fetches, writes or searches for lost
   commits (that search runs on demand in the app, not in the scan).
2. Creates 50 fixture repositories with `scripts/make-fixtures.mjs --count 50`
   in a new folder in the OS temp folder (the script refuses any other
   target), with an isolated git configuration.
3. Scans them five times and prints each scan's discovery, summary and total
   time. The run fails when the scan does not find exactly the expected
   repositories.
4. `bench:check` also fails when any scan takes over 5 s.
5. Removes the temporary folder (kept only when the run fails, for
   inspection).

The time is wall-clock time of the whole scan as the dashboard needs it,
including starting every git process. File system caches are warm after the
fixtures are created, as they are for a running app.

### Real folders

`npm run bench -- --real [<folder>...]` scans the given folders, or the
user's Desktop and Documents, once with the same tool and the same read-only
commands, and prints the count, the time and the ten slowest repositories. It
creates nothing. It was run by hand once for this report; repository names
are not recorded here.

### Cold start

`npm run bench -- --app` (add `--no-build` to use an existing release
build):

1. Creates the 50 fixtures as above and launches `target/release/repowatch.exe`
   five times, each time with a new settings folder (`REPOWATCH_CONFIG_DIR`)
   naming only the fixtures, a new WebView2 data folder
   (`WEBVIEW2_USER_DATA_FOLDER`, so every launch starts with an empty
   WebView2 profile), and the fixtures' isolated git configuration.
2. The start time is taken in the script just before the process is
   spawned. WebView2 remote debugging is enabled on a free local port
   (`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`) and Playwright attaches to the
   page.
3. The dashboard sets the performance mark `repowatch:dashboard-painted`
   (`src/features/dashboard/Ledger.tsx`) in the frame after the first
   repository rows are rendered. Performance entries are buffered, so
   attaching late loses nothing. "First paint" is the page's
   `first-contentful-paint` entry. Both are converted to wall-clock time
   with the page's `performance.timeOrigin` and compared with the spawn time.
4. "Dashboard with repositories" therefore includes window creation,
   WebView2 start, loading the interface, the first full scan of the 50
   fixtures and drawing the rows.

The executable and Windows' own WebView2 runtime files are in the OS file
cache (they are not flushed between launches), so this is a cold app profile
on a warm OS file cache. The first launch after a reboot can be slower.

### Idle memory

After the cold start launches, the app is launched once more without remote
debugging and left alone for 30 s (`--idle <s>` changes this). The script then
reads, three times 2 s apart, every process in the app's process tree (the app
and the WebView2 processes it started) from `Win32_Process` (private bytes,
working set) and `Win32_PerfFormattedData_PerfProc_Process` (private working
set), and reports the medians. The app is then closed (window close, forced
only if it does not quit) and the temporary folder removed.

### Sizes

`npm run build:installer` builds the release app and the NSIS installer; the
sizes are file sizes of `target/release/repowatch.exe` and
`target/release/bundle/nsis/Repowatch_0.1.0_x64-setup.exe`, also printed by
`npm run bench -- --app`. The installer does not contain the WebView2 runtime
(see [BUILD.md](BUILD.md)).

## Outliers and possible improvements

Every measurement is within its target, so no change was made for speed or
memory. The cheap improvements found, not applied, are listed in
[DECISIONS.md](DECISIONS.md) (decision 13).

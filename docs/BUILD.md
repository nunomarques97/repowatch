# Building and installing Repowatch on Windows

Repowatch ships as an unsigned, per-user NSIS installer (`Repowatch_0.1.0_x64-setup.exe`).
It installs without administrator rights, for the current Windows user only.
This page covers building it from source and installing it.

## Build the installer

Requirements, all installed once on the build machine:

- Windows 10 or 11 (x64).
- [Rust](https://rustup.rs) 1.85 or newer with the MSVC toolchain.
- Visual Studio 2022 Build Tools (or Visual Studio) with the
  "Desktop development with C++" workload.
- [Node.js](https://nodejs.org) 22.12 or newer.
- git.

From the repository folder:

```sh
npm install
npm run build:installer
npm run verify:installer
```

`npm run build:installer` builds the frontend, compiles the release app and
packages it with the Tauri CLI, which is a project dev dependency (nothing is
installed globally). The installer is written to:

```text
target/release/bundle/nsis/Repowatch_0.1.0_x64-setup.exe
```

The `target/` folder is ignored by git; installers are never committed.

On its first run the Tauri bundler downloads the NSIS compiler into its own
per-user cache (`%LOCALAPPDATA%\tauri\NSIS`) and reuses it afterwards. This is
the only download the build makes besides the npm and cargo dependencies.

`npm run verify:installer` reads the installer without running it and checks
that it:

- exists at the path above (and that the folder is git-ignored),
- is a valid Windows executable of version 0.1.0 with the product name and
  copyright `Copyright (c) 2026 Nuno Marques`,
- installs per user (its manifest asks for no administrator rights),
- carries the Repowatch icon,
- is unsigned, and is smaller than 15 MB,
- is configured with the MIT licence, whose text the installer shows.

It exits with an error, and says how to build the installer, when the file is
missing. To check a copy somewhere else: `npm run verify:installer -- <path>`.

### What the installer contains

- `repowatch.exe` (the app), a Start menu shortcut and an uninstaller.
- The licence page with the MIT licence text.
- No WebView2 runtime. Windows 11 already includes it. On an older Windows
  without it, the installer downloads Microsoft's WebView2 bootstrapper and
  installs the runtime first (this needs an internet connection).

The installer is not code-signed. Signing needs a paid certificate and is a
decision for a later release.

## Install

1. Download or copy `Repowatch_0.1.0_x64-setup.exe` to the PC and double-click it.
2. Windows SmartScreen may show **"Windows protected your PC"**, because the
   installer is not signed and is new. Click **More info**, check that the
   file is the one you built or downloaded, then click **Run anyway**.
3. Accept the MIT licence and click **Install**. No administrator prompt
   appears. Repowatch is installed to `%LOCALAPPDATA%\Repowatch` and gets a
   Start menu entry. The last page offers a desktop shortcut.
4. Start Repowatch from the Start menu. Add the folders that hold your
   repositories in Settings.

To compare a downloaded installer with a published checksum, run this in
PowerShell in the folder that holds it:

```powershell
Get-FileHash .\Repowatch_0.1.0_x64-setup.exe -Algorithm SHA256
```

## Uninstall

Open **Settings > Apps > Installed apps**, find Repowatch, click the **...**
menu and choose **Uninstall**. Your settings, in
`%APPDATA%\io.github.nunomarques97.repowatch`, are kept unless you tick
**Delete the application data** in the uninstaller.
Repowatch never writes inside your repositories except when you run a git
action yourself.

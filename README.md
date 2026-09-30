<div align="center">

# OpenChamber Makefile

**Run your project's Makefile from [OpenChamber](https://openchamber.dev).**
The rail panel lists every target as an accordion; open one and its live output
streams in as `make` runs.

English · [简体中文](./README.zh-CN.md)

[![License: Apache 2.0](https://img.shields.io/badge/license-Apache_2.0-blue.svg)](./LICENSE)
[![OpenChamber](https://img.shields.io/badge/OpenChamber-%3E%3D%202.0.0-6f42c1.svg)](https://openchamber.dev)
[![Panel languages](https://img.shields.io/badge/panel_en%20%2F%20zh--cn%20%2F%20zh--tw-2ea44f.svg)](#languages)

<img src="./demo/screenshot/panel.png" alt="The Makefile panel: a project's targets as an accordion, one expanded with its run output" width="640" />

</div>

The panel reads the makefile of the project you have open and turns each target
into a collapsible row. Clicking a row expands it and, the first time, starts
`make <target>` right there; the output keeps appending until the process ends.

> Built as an OpenChamber **extension** (rail panel + local service), not an
> OpenCode plugin.

## Contents

- [Features](#features)
- [How it works](#how-it-works)
- [Install](#install)
- [Usage](#usage)
- [Permissions](#permissions)
- [Limitations](#limitations)
- [Development](#development)
- [Languages](#languages)
- [License](#license)

## Features

- **Every target, one list** — `GNUmakefile`, `makefile` or `Makefile`, read in
  make's own lookup order.
- **Accordion rows** — click a target to expand it; the first click also runs it.
- **Search the targets** — filter the list by name or description from the search
  box at the top.
- **Live output** — stdout and stderr are appended as the target runs, in a
  terminal-styled log: ANSI colours are honoured and progress lines that redraw
  themselves are collapsed to one line.
- **Your terminal's environment** — the service asks your own shell for its
  environment once, so the PATH and exports from `~/.zprofile` / `~/.zshrc`
  (`nvm`, `pyenv`, project variables) reach `make` just like in a terminal.
- **Status at a glance** — running / done / failed / stopped, with the exit code
  and duration once it finishes.
- **Stop, rerun, copy, clear** — control a run without leaving the panel.
- **Works with the page closed** — the local service owns the process, so a long
  build is not tied to the tab.
- **Localized panel** — follows the OpenChamber language (English, 简体中文,
  繁體中文).
- **No project pollution** — nothing is written into the project; logs stay in
  the service's memory.

## How it works

The iframe cannot start a process, so the extension ships a **local service**
(`contributes.service`). The host spawns it once the user approves it; the panel
only talks to it through `serviceRequest`.

```
panel (iframe) --serviceRequest--> host --127.0.0.1:port--> service --spawn--> make <target>
```

State travels as an **event stream**: the service keeps a sequenced event log
and `GET /events` returns it as SSE frames, held open until there is something to
send.

- **Commands** (request/response): `GET /targets` returns the parsed targets, the
  latest run of each and the current event cursor; `POST /run` starts
  `make <target>`; `POST /stop` sends `SIGTERM` (then `SIGKILL` if it lingers).
- **Events** (push): `run` (started / finished), `output` (an output chunk) and
  `targets` (the makefile changed). The panel opens **one** stream, applies every
  event, advances its cursor and reopens the stream the moment an answer arrives —
  one connection for all runs, not one poll per run.
- **Backfill**: a run that already existed when the panel opened is fetched once
  through `GET /run?offset=&to=`; the live tail then arrives as events.
- If a panel falls behind the buffer, the service sends a `reset` frame and the
  panel reloads the full state.

The host bridge buffers a service response (there is no streaming call yet), so
`/events` is long-held rather than a socket — but it is plain SSE frames, so
swapping in a real `EventSource` later needs no protocol change.

The service keeps the last 40 runs in memory and caps each run's output, so a
very chatty target cannot grow without bound. Logs are not written to disk and
disappear when the service stops.

## Install

OpenChamber **2.0.0 or newer**, web or desktop.

1. **Settings → Extensions**.
2. Paste one of these into **folder, ZIP or URL** and press **Add**:
   - the latest packaged zip — this URL always points at the newest build:
     `https://github.com/open-tecmz/openchamber-makefile/releases/latest/download/openchamber-makefile-latest.zip`
   - the `.zip` file from the latest **Releases** page,
   - the `dist/` folder of a local clone (run `make build` or `npm run build`
     once first),
   - the git URL of the `release` branch —
     `https://github.com/open-tecmz/openchamber-makefile.git#release`
     (git installs can **Update** from Settings → Extensions when `package.json`
     version increases; a zip install cannot, so re-add the newer zip by hand).
3. Approve the permission dialog (**Allow and enable**). It lists the local
   service, which runs `make` with your full user rights.

## Usage

Open the **Makefile** panel from the extensions area of the rail:

1. The panel follows the project you have open and lists its targets.
2. Type in the search box at the top to filter targets by name or description;
   press `Esc` (or the ×) to clear it.
3. Click a target: the row expands and `make <target>` starts; the log fills in
   as it runs.
4. Use **Stop** to cancel, **Copy** to take the log elsewhere, **Clear** to empty
   the view, and **Run again** to repeat a finished target.

A target with no previous run starts on the first click; one that already ran
just shows its last output until you press **Run again**.

The service asks your shell (`$SHELL`) for its environment once at boot and gives
it to every run, so a target sees the same `PATH` and exports as it would in your
terminal.

`contributes.page` also opens the same panel full-screen, which is handy for a
build with a lot of output.

## Permissions

| Capability | Why |
| --- | --- |
| `service` | the local service reads the makefile and starts `make`; it runs with your full user rights |

The service declares `permissions.exec: ["make"]` so the approval dialog says
what it intends to run. The extension asks for no other capability: it reads no
session data and no project files beyond the makefile.

## Limitations

- **The local service must be approved** — without it there is no way to start a
  process from the panel, and the panel says so.
- **Cold start** — OpenChamber spawns the service on demand, so after the
  OpenChamber process restarts the panel shows “connecting” until the first
  request brings the service back.
- **Output is capped** — the newest ~400 KB of a run are kept; older output is
  dropped and the panel marks it as truncated.
- **The event stream is capped** — OpenChamber's service bridge aborts a single
  proxied request at 20 s, so the service holds each `/events` request for at
  most 15 s and the panel reopens it right away. The panel asks for a 30 s hold,
  which the service clamps to stay under the bridge limit.
- **The recipe shell is make's own** — the panel imports your environment, not
  your interpreter: recipes still run under make's default `/bin/sh`. Set `SHELL`
  in the Makefile (for example `SHELL := /bin/zsh`) when a recipe needs another
  shell's syntax.
- **One run per target** — starting a target again replaces its previous output.
- **Non-public process access** — the service runs under your account with no OS
  sandbox, exactly as the approval dialog warns.
- Extensions do not load in VS Code or the mobile app, so this one does not
  either.

## Development

```bash
npm install
make build          # assembles the installable package into dist/
make typecheck
make test           # builds, then runs the service test and the i18n test
```

`npm run build` (or `make build`) writes the whole installable package to
`dist/`: `dist/package.json`, `dist/icon.svg`, `dist/panel/index.html`, and the
two bundles `dist/panel/main.js` (browser IIFE) + `dist/service/main.js` (Node
ESM). The host loads built `.js` files as they sit in the package, so the page
and its bundle must stay in the same folder. `dist/` is generated and **not
committed**; CI builds it on every push to `main`.

To run your build while developing, folder-install `dist/` (Settings →
Extensions): it runs from your folder, so edit, rebuild, and reload.

The host never compiles an extension: ship built files only. Editing
`src/i18n.ts` and rebuilding is enough to add a language. These are the only
`devDependencies`; nothing here ships `node_modules`. Record every change in
`changelog.md` before you finish — the repo rule lives in `AGENTS.md`.

## Languages

The panel follows the OpenChamber language and falls back to English. Panel copy
ships in `en`, `zh-cn` and `zh-tw`; add one by extending `DICTIONARIES` in
`src/i18n.ts` — the dictionary type makes a missing key a compile error. This
documentation ships in English (this file) and 简体中文
([README.zh-CN.md](./README.zh-CN.md)).

## License

[Apache-2.0](./LICENSE).

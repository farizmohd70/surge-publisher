# Surge Publisher

A simple desktop app for publishing static websites with [Surge](https://surge.sh).
Add your sites, drop in a folder, and publish with one click, no terminal needed.

![Surge Publisher icon](icon.png)

## Features

- Manage many sites in one list: pin, archive, colour, emoji, drag to reorder
- **Categories** with colours, emoji and drag-and-drop
- **Multiple Surge accounts**, with tokens encrypted by your operating system
- One-click publish, **Publish all**, optional auto-publish when files change
- Pre-publish checks (missing `index.html`, `.env` / key files, `.git`, `node_modules`, huge files)
- Exclude rules (gitignore style), optional build command, SPA mode (`200.html`)
- Drop files in, with automatic backup of anything replaced, plus Undo
- Site health dots, QR codes, command palette (`Ctrl K`), live output log
- Light / dark themes

## Download

Grab the latest Windows portable `.exe` from the
[Releases page](https://github.com/farizmohd70/surge-publisher/releases).

## Requirements

- [Node.js](https://nodejs.org) (the app installs and runs the Surge CLI through it)
- A free [Surge](https://surge.sh) account (you can create one from inside the app)

## Run from source

```bash
git clone https://github.com/farizmohd70/surge-publisher.git
cd surge-publisher
npm install
npm start
```

## Build

```bash
npm run build
```

The portable Windows build appears in `dist/`.

## Privacy and security

- Your site list and settings are stored locally on your machine.
- Account tokens are encrypted with the OS keychain (Electron `safeStorage`) and are **never exported**.
- Passwords are used once to sign in and then discarded.
- Nothing is sent anywhere except to Surge, when you publish.

Found a vulnerability? Please read [SECURITY.md](SECURITY.md).

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE) © farizmohd70

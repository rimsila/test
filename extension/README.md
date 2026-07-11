# URL Preview Side Panel

A Chrome Manifest V3 extension for previewing web URLs in Chrome's right-side panel.

## Install

1. Download the files in this folder.
2. Open `chrome://extensions` in Chrome.
3. Enable **Developer mode**.
4. Click **Load unpacked** and select this `extension` folder.
5. Pin the extension, then click its toolbar icon to open the side panel.

## Notes

- Use **Preview** to load a URL.
- Use **Use current tab** to copy the active page into the preview.
- Use the **− / +** button to collapse or expand the preview.
- Some websites prevent iframe embedding with security headers. For those sites, use **Open in new tab**.

## Local Git server

1. Open the `server` folder in a terminal.
2. Copy `.env.example` to `.env` and set `REPO_PATH` and a long `EXTENSION_TOKEN`.
3. Run `npm install`, then `npm start`.
4. Paste the same token into the extension's **Server token** field.

The Git panel supports status, manual pull, commit, push, and auto sync. Auto sync is off by default and only runs when the working tree is clean. Pull uses `--ff-only` to avoid automatic merge commits.

The side panel has persistent **Preview** and **Git** tabs. It remembers the selected tab, last preview URL, collapsed preview state, server token, and server-side auto-sync preference.

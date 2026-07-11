# Todo project: Google Drive sync

This folder contains a basic todo web app and helper files for syncing the local project to Google Drive without uploading Git metadata or generated files.

You now have two ways to sync:

- `sync-todo.js`: Node.js-based upload flow, so you do not need to install `rclone`
- `sync-todo.ps1` / `sync-todo.sh`: `rclone`-based flow if you prefer that tool

## Google Drive destination

The scripts use this rclone destination by default:

```text
gdrive:todo
```

`gdrive` is the name of the rclone remote. `todo` is the folder in Google Drive.

## 1. Node.js sync option

Node.js is already available in many environments and avoids a separate `rclone` install.

Install the repo dependency once:

```bash
npm install
```

Create a Google OAuth desktop app credential in Google Cloud, download the JSON file, and save it as:

```text
google-drive-credentials.json
```

The first run opens an OAuth flow and stores the token locally in:

```text
.google-drive-token.json
```

Both files are excluded from upload by `rclone-exclude.txt`.

Preview the upload:

```bash
npm run sync:drive:dry
```

Upload new and changed files into the Drive folder `todo`:

```bash
npm run sync:drive
```

Use a different source folder or Drive destination:

```bash
node sync-todo.js "C:\Projects\todo" --remote "backups/todo" --dry-run
```

This Node.js flow uploads new files and updates existing files with the same name in the same Drive folder. It does not delete extra files in Google Drive.

## 2. Install and configure rclone

Install rclone, then run:

```bash
rclone config
```

Create a new remote named `gdrive`, choose **Google Drive**, and complete browser authorization.

Confirm the connection:

```bash
rclone lsd gdrive:
```

## 3. Files excluded from upload

`rclone-exclude.txt` excludes common development-only content, including:

- `.git/` and other Git metadata files
- `.github/`
- `node_modules/`
- build and cache folders
- editor settings
- logs and temporary files
- local `.env` files
- local Google OAuth credential/token files

The filter does not delete these files locally. It only prevents rclone from copying them to Google Drive.

## 4. Windows PowerShell

The PowerShell script defaults to syncing the current repo folder, so you can run it directly from this project.

Preview the upload first:

```powershell
.\sync-todo.ps1 -DryRun
```

Upload new and changed files without deleting extra Drive files:

```powershell
.\sync-todo.ps1
```

Mirror the local folder exactly to Drive:

```powershell
.\sync-todo.ps1 -Mirror -DryRun
.\sync-todo.ps1 -Mirror
```

`-Mirror` uses `rclone sync`, which can delete destination files that do not exist locally. Always run it once with `-DryRun` first.

To target a different folder or Drive path:

```powershell
.\sync-todo.ps1 -Source "C:\Projects\todo" -Remote "gdrive:todo"
```

## 5. macOS or Linux

Make the script executable once:

```bash
chmod +x sync-todo.sh
```

The shell script also defaults to the current repo folder.

Preview:

```bash
./sync-todo.sh --dry-run
```

Upload safely with copy mode:

```bash
./sync-todo.sh
```

Mirror with sync mode:

```bash
./sync-todo.sh --sync --dry-run
./sync-todo.sh --sync
```

To target a different folder or Drive path:

```bash
./sync-todo.sh "$HOME/Projects/todo" --remote "gdrive:todo"
```

## 6. Direct rclone command

A direct safe-copy command is:

```bash
rclone copy "/path/to/todo" "gdrive:todo" \
  --exclude-from "/path/to/rclone-exclude.txt" \
  --progress
```

Use `copy` for routine uploads. It does not remove unrelated files already in Google Drive.

## Important notes

- `.gitignore` controls Git only; it does not control Google Drive syncing.
- Google Drive for desktop does not provide project-style glob exclusions comparable to rclone filters.
- Keep `rclone-exclude.txt` beside the sync script or update the script path.
- Do not store credentials, tokens, or `.env` secrets in Google Drive.

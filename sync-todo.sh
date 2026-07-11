#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE="$SCRIPT_DIR"
REMOTE="${RCLONE_REMOTE:-gdrive:todo}"
MODE="copy"
DRY_RUN=()

FILTER_FILE="$SCRIPT_DIR/rclone-exclude.txt"

while (($#)); do
  case "$1" in
    --sync) MODE="sync" ;;
    --dry-run) DRY_RUN+=(--dry-run) ;;
    --remote)
      shift
      [[ $# -gt 0 ]] || {
        echo "Missing value for --remote" >&2
        exit 2
      }
      REMOTE="$1"
      ;;
    --help|-h)
      cat <<EOF
Usage: ./sync-todo.sh [source-dir] [--remote REMOTE] [--dry-run] [--sync]

Defaults:
  source-dir   $SCRIPT_DIR
  remote       $REMOTE
EOF
      exit 0
      ;;
    --*)
      echo "Unknown option: $1" >&2
      exit 2
      ;;
    *)
      SOURCE="$1"
      ;;
  esac
  shift
done

command -v rclone >/dev/null 2>&1 || {
  echo "rclone is not installed or not available in PATH." >&2
  exit 1
}

[[ -d "$SOURCE" ]] || {
  echo "Source folder does not exist: $SOURCE" >&2
  exit 1
}

[[ -f "$FILTER_FILE" ]] || {
  echo "Filter file does not exist: $FILTER_FILE" >&2
  exit 1
}

rclone "$MODE" "$SOURCE" "$REMOTE" \
  --exclude-from "$FILTER_FILE" \
  --create-empty-src-dirs \
  --progress \
  --verbose \
  "${DRY_RUN[@]}"

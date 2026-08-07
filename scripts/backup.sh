#!/bin/sh
set -eu

backup_dir=/backups
retention_days="${BACKUP_RETENTION_DAYS:-14}"
interval_seconds="${BACKUP_INTERVAL_SECONDS:-86400}"

mkdir -p "$backup_dir"

while true; do
  timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
  target="$backup_dir/threatlens-$timestamp.dump"
  pg_dump --format=custom --no-owner --no-acl "$DATABASE_URL" --file="$target"
  pg_restore --list "$target" >/dev/null
  sha256sum "$target" > "$target.sha256"
  find "$backup_dir" -type f -name 'threatlens-*.dump' -mtime "+$retention_days" -delete
  find "$backup_dir" -type f -name 'threatlens-*.dump.sha256' -mtime "+$retention_days" -delete
  sleep "$interval_seconds"
done

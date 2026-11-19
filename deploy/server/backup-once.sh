#!/bin/sh
set -eu
umask 077
backup_directory=${PAY_BACKUP_DIR:-/www/server/brclio-pay/backups}
database_path=${PAY_DATABASE_PATH:-/www/server/brclio-pay/data/brclio-pay.sqlite}
backup_tool=${PAY_BACKUP_TOOL:-/www/server/brclio-pay/bin/backup-sqlite.py}
timestamp=$(date -u +%Y%m%dT%H%M%SZ)
exec /usr/bin/python3 "$backup_tool" --database "$database_path" --output "$backup_directory/brclio-pay-$timestamp-$$.sqlite"

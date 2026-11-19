#!/usr/bin/env python3
"""Create one private, verified SQLite online backup without overwriting files.

The SQLite backup API includes committed WAL content and every table: payment
documents, runtime configuration, migration provenance and source archives.
Never copy only the live .sqlite file, and never print rows or configuration.
"""

import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import stat
import sys
import tempfile
import time


class BackupError(Exception):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def require(condition, code):
    if not condition:
        raise BackupError(code)


def checked_path(value):
    path = Path(value)
    require(path.is_absolute() and ".." not in path.parts and "\0" not in value, "ABSOLUTE_SAFE_PATH_REQUIRED")
    current = Path(path.anchor)
    for part in path.parts[1:]:
        current = current / part
        try:
            info = current.lstat()
        except FileNotFoundError:
            continue
        require(not stat.S_ISLNK(info.st_mode), "SYMLINK_PATH_REJECTED")
    return path


def sync_directory(path):
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0))
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def backup(database, output):
    os.umask(0o077)
    source_path, output_path = checked_path(database), checked_path(output)
    try:
        source_stat = source_path.lstat()
    except FileNotFoundError:
        raise BackupError("DATABASE_NOT_FOUND") from None
    require(stat.S_ISREG(source_stat.st_mode), "DATABASE_NOT_REGULAR_FILE")
    require(source_path != output_path, "OUTPUT_EQUALS_DATABASE")
    require(not os.path.lexists(output_path), "OUTPUT_ALREADY_EXISTS")
    output_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    checked_path(str(output_path.parent))
    directory_stat = output_path.parent.stat()
    require(stat.S_ISDIR(directory_stat.st_mode), "OUTPUT_DIRECTORY_REQUIRED")
    require(directory_stat.st_uid == os.geteuid(), "OUTPUT_DIRECTORY_OWNER_MISMATCH")
    require(directory_stat.st_mode & 0o077 == 0, "OUTPUT_DIRECTORY_MUST_BE_PRIVATE")
    descriptor, staging_name = tempfile.mkstemp(prefix=".brclio-pay-backup-", suffix=".sqlite", dir=output_path.parent)
    os.fchmod(descriptor, 0o600)
    os.close(descriptor)
    staging_path = Path(staging_name)
    source = destination = None
    deadline = time.monotonic() + 240
    try:
        # mode=ro never creates or writes business records; immutable=1 must NOT
        # be used because it can ignore the source's active WAL.
        source = sqlite3.connect(source_path.as_uri() + "?mode=ro", uri=True, timeout=30)
        source.execute("PRAGMA query_only=ON")
        destination = sqlite3.connect(staging_path, timeout=30)
        destination.execute("PRAGMA synchronous=FULL")

        def progress(_status, _remaining, _total):
            require(time.monotonic() < deadline, "BACKUP_TIMEOUT")

        source.backup(destination, pages=256, progress=progress, sleep=0.05)
        require(destination.execute("PRAGMA integrity_check").fetchall() == [("ok",)], "BACKUP_INTEGRITY_FAILED")
        require(not destination.execute("PRAGMA foreign_key_check").fetchall(), "BACKUP_FOREIGN_KEY_CHECK_FAILED")
        table_count = destination.execute("SELECT count(*) FROM sqlite_schema WHERE type='table'").fetchone()[0]
        # Publish one standalone database, not a backup requiring its own WAL.
        destination.execute("PRAGMA journal_mode=DELETE").fetchone()
        destination.close()
        destination = None
        source.close()
        source = None
        require(not Path(staging_name + "-wal").exists(), "BACKUP_WAL_REMAINS")
        descriptor = os.open(staging_path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        try:
            os.fsync(descriptor)
            digest = hashlib.sha256()
            with os.fdopen(os.dup(descriptor), "rb") as stream:
                for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                    digest.update(chunk)
            size = os.fstat(descriptor).st_size
        finally:
            os.close(descriptor)
        # Linking a completed temporary file is atomic and refuses any existing
        # destination, including a symlink created after the initial check.
        try:
            os.link(staging_path, output_path, follow_symlinks=False)
        except FileExistsError:
            raise BackupError("OUTPUT_ALREADY_EXISTS") from None
        staging_path.unlink()
        sync_directory(output_path.parent)
        return {"ok": True, "method": "sqlite-online-backup", "integrity": "ok", "tables": table_count,
                "bytes": size, "sha256": digest.hexdigest(),
                "completedAt": datetime.datetime.now(datetime.timezone.utc).isoformat()}
    finally:
        if destination is not None:
            destination.close()
        if source is not None:
            source.close()
        # Only this run's unpublished temporary files are removed. Existing
        # backups have no automatic retention/deletion policy.
        for suffix in ("", "-wal", "-shm", "-journal"):
            try:
                Path(staging_name + suffix).unlink()
            except FileNotFoundError:
                pass


def main():
    parser = argparse.ArgumentParser(description="Private SQLite online backup; existing output is never replaced.")
    parser.add_argument("--database", required=True, help="Absolute path to the live SQLite database")
    parser.add_argument("--output", required=True, help="New absolute backup path in a private directory")
    args = parser.parse_args()
    try:
        result = backup(args.database, args.output)
    except BackupError as error:
        print(json.dumps({"ok": False, "error": error.code}), file=sys.stderr)
        return 1
    except Exception:
        # SQLite/provider exception strings can contain private paths or data.
        print(json.dumps({"ok": False, "error": "BACKUP_FAILED"}), file=sys.stderr)
        return 1
    print(json.dumps(result, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    sys.exit(main())

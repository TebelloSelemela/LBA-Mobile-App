"""Consistent SQLite backups with integrity verification and retention."""
import sqlite3
import threading
from contextlib import closing
from datetime import datetime
from pathlib import Path


def backup_database(db_path, directory, retain=30):
    db_path = Path(db_path)
    directory = Path(directory)
    if not db_path.is_file():
        raise FileNotFoundError(db_path)
    directory.mkdir(parents=True, exist_ok=True)
    target = directory / ("lesbad-" + datetime.now().strftime("%Y%m%d-%H%M%S-%f") + ".sqlite3")
    partial = target.with_suffix(".sqlite3.tmp")
    try:
        with closing(sqlite3.connect(f"file:{db_path.resolve()}?mode=ro", uri=True, timeout=30)) as source:
            with closing(sqlite3.connect(partial, timeout=30)) as destination:
                source.backup(destination, pages=128, sleep=0.1)
                if destination.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                    raise RuntimeError("Backup integrity check failed")
        partial.replace(target)
        for old in sorted(directory.glob("lesbad-*.sqlite3"), reverse=True)[retain:]:
            old.unlink()
        print("Verified backup:", target)
        return target
    finally:
        partial.unlink(missing_ok=True)


def backup_loop(db_path, directory, seconds=21600):
    while True:
        threading.Event().wait(seconds)
        try:
            backup_database(db_path, directory)
        except Exception as exc:
            print("BACKUP WARNING:", exc, flush=True)


if __name__ == "__main__":
    import sys
    home = Path(__file__).resolve().parents[1]
    db = Path(sys.argv[1]) if len(sys.argv) > 1 else home / "local-data" / "lesbad.sqlite3"
    backup_database(db, home / "local-data" / "backups")

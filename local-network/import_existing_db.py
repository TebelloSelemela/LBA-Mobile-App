"""Import an existing verified SQLite backup (will NEVER overwrite local data)."""
import argparse
import sqlite3
from contextlib import closing
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_TARGET = ROOT / "local-data" / "lesbad.sqlite3"


def import_existing(source, target=DEFAULT_TARGET):
    source, target = Path(source).resolve(), Path(target).resolve()
    if not source.is_file():
        raise FileNotFoundError(source)
    if target.exists():
        raise FileExistsError(f"Refusing to overwrite the local database: {target}")
    target.parent.mkdir(parents=True, exist_ok=True)
    partial = target.with_suffix(".sqlite3.partial")
    if partial.exists():
        raise FileExistsError(partial)
    required = {"players", "draws", "draw_matches", "tournaments", "users"}
    try:
        with closing(sqlite3.connect(f"file:{source}?mode=ro", uri=True)) as origin:
            tables = {r[0] for r in origin.execute(
                "SELECT name FROM sqlite_master WHERE type='table'")}
            if not required.issubset(tables):
                raise ValueError("Not a LESBAD backup. Missing: "+", ".join(sorted(required-tables)))
            with closing(sqlite3.connect(partial)) as dest:
                origin.backup(dest)
                if dest.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                    raise RuntimeError("Database backup failed integrity verification.")
        partial.replace(target)
        print("Database restored:", target)
        print("Tournament records and existing user passwords retained.")
    finally:
        partial.unlink(missing_ok=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("sqlite_backup")
    args = parser.parse_args()
    import_existing(args.sqlite_backup)

"""List local LESBAD account names/roles without revealing credentials."""
import sqlite3
from pathlib import Path

DB_FILE = Path(__file__).resolve().parents[1] / "local-data" / "lesbad.sqlite3"

if not DB_FILE.is_file():
    raise SystemExit("No local LESBAD database exists yet.")
with sqlite3.connect(f"file:{DB_FILE.resolve()}?mode=ro", uri=True) as con:
    users = con.execute(
        "SELECT username,role,is_active FROM users ORDER BY username COLLATE NOCASE"
    ).fetchall()
    if not users:
        print("No local accounts found.")
    for username, role, active in users:
        print(f"Username: {username} | Role: {role} | {'Active' if active else 'Inactive'}")
    print("This does not reveal or reset passwords.")

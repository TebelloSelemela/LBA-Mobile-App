"""LESBAD LAN host: Flask API + locally served React application."""
import json
import os
import sqlite3
import sys
import threading
from pathlib import Path

from flask import abort, send_from_directory
from waitress import serve

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "local-data"
CONFIG_FILE = DATA / "config.json"
DIST = ROOT / "frontend" / "dist"
DB_FILE = DATA / "lesbad.sqlite3"

if not CONFIG_FILE.is_file():
    raise SystemExit("Run local-network/configure.py first (start-server.bat does this automatically).")
if not (DIST / "index.html").is_file():
    raise SystemExit("frontend/dist/index.html missing. Download the prebuilt LAN Server ZIP.")

config = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
if not config.get("admin_password"):
    raise SystemExit("Missing local admin seed password.")
os.environ["LBA_DB_PATH"] = str(DB_FILE.resolve())
os.environ["LBA_ADMIN_PASSWORD"] = config["admin_password"]
os.environ["LBA_ADMIN_USERNAME"] = config.get("admin_username", "admin")
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from backend.app import app  # noqa: E402
from local_network_backup import backup_database, backup_loop  # noqa: E402

with sqlite3.connect(DB_FILE, timeout=20) as con:
    con.execute("PRAGMA busy_timeout=20000")
    con.execute("PRAGMA journal_mode=WAL")
    con.execute("PRAGMA synchronous=NORMAL")

# SQLite's backup API captures a coherent snapshot while writes continue.
backup_database(DB_FILE, DATA / "backups")
threading.Thread(target=backup_loop,
                 args=(DB_FILE, DATA / "backups", 6 * 60 * 60),
                 daemon=True, name="lesbad-backup").start()


@app.get("/")
@app.get("/<path:asset_path>")
def serve_local_frontend(asset_path=""):
    if asset_path == "api" or asset_path.startswith("api/"):
        abort(404)
    target = DIST / asset_path
    if asset_path and target.is_file() and target.resolve().is_relative_to(DIST.resolve()):
        return send_from_directory(DIST, asset_path)
    return send_from_directory(DIST, "index.html")


if __name__ == "__main__":
    port = int(config.get("port", 5050))
    print("LESBAD LAN SERVER")
    print(f"Desktop 1: http://127.0.0.1:{port}")
    print(f"Other devices: http://<DESKTOP-1-IP>:{port}")
    print("Keep this window running. Use staff-only, private Wi-Fi.")
    serve(app, host="0.0.0.0", port=port, threads=6, connection_limit=100)

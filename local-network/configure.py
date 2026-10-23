"""First-time administrator seed password: stored only on Desktop 1."""
import getpass
import json
import os
import stat
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "local-data"
SETTINGS = DATA / "config.json"


def configure():
    DATA.mkdir(exist_ok=True)
    if SETTINGS.exists():
        print("Existing local configuration preserved:", SETTINGS)
        return
    print("LESBAD LOCAL SERVER CONFIGURATION")
    print("For a migrated database, existing users retain their old passwords.")
    username = input("New-database administrator username [admin]: ").strip() or "admin"
    while True:
        secret = getpass.getpass("New-database admin password (at least 12 characters): ")
        confirm = getpass.getpass("Confirm password: ")
        if len(secret) < 12:
            print("Password must be at least 12 characters.")
        elif secret != confirm:
            print("Passwords do not match.")
        else:
            break
    fd = os.open(str(SETTINGS), os.O_WRONLY | os.O_CREAT | os.O_EXCL,
                 stat.S_IRUSR | stat.S_IWUSR)
    with os.fdopen(fd, "w", encoding="utf-8") as out:
        json.dump({"admin_username": username, "admin_password": secret, "port": 5050}, out)
    print("Saved local config. Restrict access to the local-data folder.")


if __name__ == "__main__":
    configure()

"""Regression tests: local administrator bootstrap preserves existing users."""
import ast
import sqlite3
import unittest
from pathlib import Path

SOURCE = Path(__file__).resolve().parents[2] / "backend" / "app.py"
program = ast.parse(SOURCE.read_text(encoding="utf-8"))
func = next(n for n in program.body
            if isinstance(n, ast.FunctionDef) and n.name == "_seed_initial_administrator")
scope = {}
exec(compile(ast.Module(body=[func], type_ignores=[]), str(SOURCE), "exec"), scope)
bootstrap = scope["_seed_initial_administrator"]


class AdminBootstrapTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.db.row_factory = sqlite3.Row
        self.db.execute("""
            CREATE TABLE users(
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              username TEXT UNIQUE NOT NULL,
              email TEXT UNIQUE NOT NULL,
              full_name TEXT, password_hash TEXT, role TEXT,
              is_active INTEGER, email_verified INTEGER,
              created_at TEXT, updated_at TEXT
            )
        """)

    def tearDown(self):
        self.db.close()

    def seed(self, username="admin", email="admin@lba.local", password="secure"):
        return bootstrap(
            self.db, username, email, password, "2026-10-23T12:00:00+02:00",
            lambda value: "hashed:" + value
        )

    def users(self):
        return [dict(row) for row in self.db.execute("SELECT * FROM users ORDER BY id")]

    def test_first_start_creates_one_admin(self):
        self.assertEqual(self.seed(), "created")
        self.assertEqual(len(self.users()), 1)
        self.assertEqual(self.users()[0]["role"], "Super Admin")

    def test_restart_preserves_password(self):
        self.seed()
        self.assertEqual(self.seed(password="new-password"), "existing_username")
        self.assertEqual(len(self.users()), 1)
        self.assertEqual(self.users()[0]["password_hash"], "hashed:secure")

    def test_changed_username_same_email_skips_duplicate(self):
        self.seed()
        self.assertEqual(
            self.seed(username="new-admin", password="another-password"), "existing_email"
        )
        self.assertEqual(len(self.users()), 1)
        self.assertEqual(self.users()[0]["username"], "admin")
        self.assertEqual(self.users()[0]["password_hash"], "hashed:secure")

    def test_existing_different_user_is_not_overwritten(self):
        self.db.execute("""
            INSERT INTO users(username,email,role,password_hash)
            VALUES('committee','committee@lba.local','Viewer','unchanged')
        """)
        self.assertEqual(
            self.seed(username="different-admin", email="other@lba.local"),
            "existing_users"
        )
        self.assertEqual(len(self.users()), 1)

    def test_case_insensitive_username_match(self):
        self.seed()
        self.assertEqual(self.seed(username="ADMIN"), "existing_username")
        self.assertEqual(len(self.users()), 1)


if __name__ == "__main__":
    unittest.main()

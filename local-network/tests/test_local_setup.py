"""Test LAN backup, migration protection and safe setup without launching Flask."""
import importlib.util
import sqlite3
import tempfile
import unittest
from pathlib import Path

ROOT=Path(__file__).resolve().parents[2]


def load_module(name, path):
    spec=importlib.util.spec_from_file_location(name,path)
    obj=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(obj)
    return obj


backup=load_module("local_network_backup",ROOT/"local-network"/"local_network_backup.py")
migration=load_module("import_existing_db",ROOT/"local-network"/"import_existing_db.py")


class LanDatabaseTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name)
        self.existing=self.root/"original.sqlite3"
        with sqlite3.connect(self.existing) as db:
            db.execute("CREATE TABLE players(id INTEGER PRIMARY KEY,name TEXT)")
            db.execute("INSERT INTO players(name) VALUES('Existing athlete')")
            db.commit()

    def test_backup_is_consistent(self):
        file=backup.backup_database(self.existing,self.root/"backups")
        with sqlite3.connect(file) as db:
            self.assertEqual(db.execute("SELECT name FROM players").fetchone()[0],
                             "Existing athlete")
            self.assertEqual(db.execute("PRAGMA integrity_check").fetchone()[0],"ok")

    def test_backup_retention(self):
        out=self.root/"backups"
        for _ in range(4):
            backup.backup_database(self.existing,out,retain=2)
        self.assertEqual(len(list(out.glob("lesbad-*.sqlite3"))),2)

    def test_import_refuses_non_lesbad_database(self):
        with self.assertRaises(ValueError):
            migration.import_existing(self.existing,self.root/"target.sqlite3")
        self.assertFalse((self.root/"target.sqlite3").exists())

    def test_import_validates_and_does_not_overwrite(self):
        db=self.root/"lesbad.sqlite3"
        with sqlite3.connect(self.existing) as con:
            for name in ("draws","draw_matches","tournaments","users"):
                con.execute(f"CREATE TABLE {name}(id INTEGER PRIMARY KEY)")
        migration.import_existing(self.existing,db)
        with self.assertRaises(FileExistsError):
            migration.import_existing(self.existing,db)
        with sqlite3.connect(db) as con:
            self.assertEqual(con.execute("SELECT name FROM players").fetchone()[0],
                             "Existing athlete")

    def test_source_routes_browser_to_local_origin(self):
        jsx=(ROOT/"frontend"/"src"/"main.jsx").read_text(encoding="utf-8")
        self.assertIn("window.location.origin + '/api'",jsx)
        server=(ROOT/"local-network"/"server.py").read_text(encoding="utf-8")
        self.assertIn('app.get("/<path:asset_path>")',server)
        self.assertIn('serve(app, host="0.0.0.0"',server)


if __name__=="__main__":
    unittest.main()

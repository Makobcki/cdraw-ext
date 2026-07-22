import unittest
import os
import sys
import json
import tempfile
import zipfile

# Add backend directory to sys.path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import updater
from app import app

INITIAL_VERSION_DATA = {
    "version": "1.0.0",
    "auto_check": True,
    "update_url": "https://raw.githubusercontent.com/Makobcki/cdraw-ext/main/backend/version.json",
    "last_checked": None,
    "latest_version": "1.0.0",
    "release_notes": "",
    "download_url": "https://github.com/Makobcki/cdraw-ext/archive/refs/heads/main.zip",
    "update_available": False,
    "last_updated": None,
    "last_backup": None
}

class TestAutoUpdater(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.original_version_content = None
        if os.path.exists(updater.VERSION_FILE):
            try:
                with open(updater.VERSION_FILE, "r", encoding="utf-8") as f:
                    cls.original_version_content = f.read()
            except Exception:
                pass

    @classmethod
    def tearDownClass(cls):
        if cls.original_version_content is not None:
            try:
                with open(updater.VERSION_FILE, "w", encoding="utf-8") as f:
                    f.write(cls.original_version_content)
            except Exception:
                pass

    def setUp(self):
        self.app = app.test_client()
        self.app.testing = True

    def tearDown(self):
        pass

    def test_01_version_info(self):
        info = updater.load_version_info()
        self.assertTrue(isinstance(info["version"], str))
        self.assertIn("auto_check", info)
        self.assertIn("Makobcki/cdraw-ext", info.get("update_url", ""))

    def test_02_compare_versions(self):
        self.assertEqual(updater.compare_versions("1.1.0", "1.0.0"), 1)
        self.assertEqual(updater.compare_versions("1.0.0", "1.0.0"), 0)
        self.assertEqual(updater.compare_versions("1.0.0", "1.1.0"), -1)
        self.assertEqual(updater.compare_versions("2.0.0", "1.9.9"), 1)

    def test_03_venv_python_detection(self):
        py_exe = updater.get_venv_python()
        self.assertTrue(isinstance(py_exe, str))
        self.assertTrue(len(py_exe) > 0)

    def test_04_find_backend_dir(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            repo_dir = os.path.join(temp_dir, "cdraw-ext-main")
            backend_subdir = os.path.join(repo_dir, "backend")
            os.makedirs(backend_subdir, exist_ok=True)
            with open(os.path.join(backend_subdir, "app.py"), "w") as f:
                f.write("# dummy app")

            detected = updater.find_backend_dir(temp_dir)
            self.assertEqual(detected, backend_subdir)

    def test_05_updater_status_route(self):
        res = self.app.get("/updater/status")
        self.assertEqual(res.status_code, 200)
        data = res.get_json()
        self.assertIn("version", data)

    def test_06_updater_check_route(self):
        res = self.app.post("/updater/check", json={"mock_version": "9.9.9"})
        self.assertEqual(res.status_code, 200)
        data = res.get_json()
        self.assertTrue(data["update_available"])
        self.assertEqual(data["latest_version"], "9.9.9")

    def test_07_updater_settings_route(self):
        res = self.app.post("/updater/settings", json={"auto_check": False})
        self.assertEqual(res.status_code, 200)
        data = res.get_json()
        self.assertFalse(data["auto_check"])

        # Reset back
        self.app.post("/updater/settings", json={"auto_check": True})

    def test_08_apply_and_rollback(self):
        orig_info = updater.load_version_info()
        orig_ver = orig_info["version"]

        # Create a mock zip update file
        with tempfile.TemporaryDirectory() as temp_dir:
            mock_zip = os.path.join(temp_dir, "mock_update.zip")
            with zipfile.ZipFile(mock_zip, "w") as zf:
                zf.writestr("cdraw-ext-main/backend/version.json", json.dumps({"version": "1.2.0"}))
                zf.writestr("cdraw-ext-main/backend/app.py", "# updated app")
                zf.writestr("cdraw-ext-main/backend/dummy_file.txt", "updated content")

            # Apply update to 1.2.0 from mock zip
            res_apply = self.app.post("/updater/apply", json={
                "source_path": mock_zip,
                "target_version": "1.2.0",
                "restart": False
            })
            self.assertEqual(res_apply.status_code, 200)
            data_apply = res_apply.get_json()
            self.assertEqual(data_apply["status"], "success")
            self.assertEqual(data_apply["version"], "1.2.0")
            self.assertIn("pip", data_apply)

            # Check dummy file exists
            dummy_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "dummy_file.txt")
            self.assertTrue(os.path.exists(dummy_path))

            # Rollback
            res_rb = self.app.post("/updater/rollback", json={"restart": False})
            self.assertEqual(res_rb.status_code, 200)
            data_rb = res_rb.get_json()
            self.assertEqual(data_rb["status"], "success")
            self.assertEqual(data_rb["version"], orig_ver)

            # Clean up dummy file if present
            if os.path.exists(dummy_path):
                os.remove(dummy_path)

    def test_09_multi_accounts_resilience(self):
        from app import load_accounts, MULTI_ACCOUNTS_FILE
        backup_acc = None
        if os.path.exists(MULTI_ACCOUNTS_FILE):
            with open(MULTI_ACCOUNTS_FILE, "r", encoding="utf-8") as f:
                backup_acc = f.read()

        try:
            # 1. Missing file
            if os.path.exists(MULTI_ACCOUNTS_FILE):
                os.remove(MULTI_ACCOUNTS_FILE)
            acc_data = load_accounts()
            self.assertEqual(acc_data, {"accounts": [], "current_index": -1})

            # 2. Empty file (0 bytes)
            with open(MULTI_ACCOUNTS_FILE, "w", encoding="utf-8") as f:
                f.write("")
            acc_data = load_accounts()
            self.assertEqual(acc_data, {"accounts": [], "current_index": -1})

            # 3. Invalid JSON
            with open(MULTI_ACCOUNTS_FILE, "w", encoding="utf-8") as f:
                f.write("invalid json content")
            acc_data = load_accounts()
            self.assertEqual(acc_data, {"accounts": [], "current_index": -1})
        finally:
            if backup_acc is not None:
                with open(MULTI_ACCOUNTS_FILE, "w", encoding="utf-8") as f:
                    f.write(backup_acc)
            elif os.path.exists(MULTI_ACCOUNTS_FILE):
                os.remove(MULTI_ACCOUNTS_FILE)

if __name__ == "__main__":
    unittest.main()

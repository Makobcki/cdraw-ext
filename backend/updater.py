import json
import os
import shutil
import sys
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request
import zipfile
from datetime import datetime

VERSION_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "version.json")
BACKUPS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "backups")

from config import atomic_write_json, read_json_locked


def get_installed_version():
    data = read_json_locked(VERSION_FILE, default_factory=dict)
    if isinstance(data, dict) and data.get("version"):
        return str(data["version"]).strip()
    return "1.0.0"


def get_default_version_data():
    curr_ver = get_installed_version()
    return {
        "version": curr_ver,
        "auto_check": True,
        "update_url": "https://raw.githubusercontent.com/Makobcki/cdraw-ext/main/backend/version.json",
        "last_checked": None,
        "latest_version": curr_ver,
        "release_notes": "",
        "download_url": "https://github.com/Makobcki/cdraw-ext/archive/refs/heads/main.zip",
        "update_available": False
    }


PRESERVE_FILES = {
    ".venv",
    "backups",
    "oauth_config.json",
    "multi_accounts.json",
    ".env",
    "version.json",
    "chats.json",
    "hidden_models.json",
}


def load_version_info():
    data = read_json_locked(VERSION_FILE, default_factory=dict)
    default_data = get_default_version_data()
    curr_ver = data.get("version") or default_data["version"]

    merged = dict(default_data)
    merged.update(data)
    merged["version"] = curr_ver

    if compare_versions(merged.get("latest_version", curr_ver), curr_ver) <= 0:
        merged["update_available"] = False
        merged["latest_version"] = curr_ver

    return merged


def save_version_info(data):
    atomic_write_json(VERSION_FILE, data)


def compare_versions(v1, v2):
    """Returns >0 if v1 > v2, <0 if v1 < v2, 0 if v1 == v2"""

    def parse(v):
        parts = []
        for p in str(v).lstrip("v").split("."):
            try:
                parts.append(int(p))
            except ValueError:
                parts.append(0)
        return parts

    p1, p2 = parse(v1), parse(v2)
    length = max(len(p1), len(p2))
    p1 += [0] * (length - len(p1))
    p2 += [0] * (length - len(p2))

    if p1 > p2:
        return 1
    elif p1 < p2:
        return -1
    return 0


def check_for_updates(force_check_remote=True, mock_version=None):
    info = load_version_info()
    default_data = get_default_version_data()
    update_url = info.get("update_url") or default_data["update_url"]
    now_str = datetime.now().isoformat()
    info["last_checked"] = now_str
    info.pop("last_check_error", None)

    if mock_version:
        latest = mock_version
        notes = f"Обновление v{mock_version}: улучшение производительности, автообновление и исправление ошибок."
        if compare_versions(latest, info["version"]) > 0:
            info["update_available"] = True
            info["latest_version"] = latest
            info["release_notes"] = notes
            if not info.get("download_url"):
                info["download_url"] = default_data["download_url"]
        else:
            info["update_available"] = False
            info["latest_version"] = info["version"]
        save_version_info(info)
        return info

    try:
        req = urllib.request.Request(
            update_url, headers={"User-Agent": "CorelDraw-AI-Agent-Updater/1.0"}
        )
        with urllib.request.urlopen(req, timeout=5) as resp:
            remote_data = json.loads(resp.read().decode("utf-8"))
            latest = remote_data.get("version") or remote_data.get("latest_version")
            if latest and compare_versions(latest, info["version"]) > 0:
                info["update_available"] = True
                info["latest_version"] = latest
                info["release_notes"] = remote_data.get(
                    "release_notes", "Доступна новая версия программы."
                )
                info["download_url"] = remote_data.get(
                    "download_url", default_data["download_url"]
                )
            else:
                info["update_available"] = False
                info["latest_version"] = info["version"]
                info["release_notes"] = ""
    except Exception as e:
        info["last_check_error"] = f"Не удалось подключиться к серверу обновлений: {str(e)}"

    save_version_info(info)
    return info


def get_venv_python(backend_dir=None):
    r"""
    Returns python executable in .venv directory.
    Standard path for Windows: ext-dir\backend\.venv\Scripts\pythonw.exe
    """
    if backend_dir is None:
        backend_dir = os.path.dirname(os.path.abspath(__file__))

    # Check backend directory .venv (ext-dir\backend\.venv\Scripts\pythonw.exe)
    win_pythonw = os.path.join(backend_dir, ".venv", "Scripts", "pythonw.exe")
    win_python = os.path.join(backend_dir, ".venv", "Scripts", "python.exe")
    posix_python3 = os.path.join(backend_dir, ".venv", "bin", "python3")
    posix_python = os.path.join(backend_dir, ".venv", "bin", "python")

    if os.name == "nt":
        if os.path.exists(win_pythonw):
            return win_pythonw
        if os.path.exists(win_python):
            return win_python
    else:
        if os.path.exists(posix_python3):
            return posix_python3
        if os.path.exists(posix_python):
            return posix_python

    # Check parent directory (if .venv is outside backend)
    parent_dir = os.path.dirname(backend_dir)
    p_win_pythonw = os.path.join(parent_dir, ".venv", "Scripts", "pythonw.exe")
    p_win_python = os.path.join(parent_dir, ".venv", "Scripts", "python.exe")
    p_posix_python3 = os.path.join(parent_dir, ".venv", "bin", "python3")
    p_posix_python = os.path.join(parent_dir, ".venv", "bin", "python")

    if os.name == "nt":
        if os.path.exists(p_win_pythonw):
            return p_win_pythonw
        if os.path.exists(p_win_python):
            return p_win_python
    else:
        if os.path.exists(p_posix_python3):
            return p_posix_python3
        if os.path.exists(p_posix_python):
            return p_posix_python

    # Cross-platform fallbacks
    for candidate in [win_pythonw, win_python, posix_python3, posix_python]:
        if os.path.exists(candidate):
            return candidate

    return sys.executable


def run_pip_install(backend_dir=None):
    """
    Executes pip install -r requirements.txt using venv python to add missing dependencies.
    """
    if backend_dir is None:
        backend_dir = os.path.dirname(os.path.abspath(__file__))

    req_file = os.path.join(backend_dir, "requirements.txt")
    if not os.path.exists(req_file):
        return {"status": "skipped", "message": "requirements.txt not found"}

    python_exe = get_venv_python(backend_dir)
    pip_python = python_exe
    if pip_python.endswith("pythonw.exe"):
        alt_exe = pip_python[:-9] + "python.exe"
        if os.path.exists(alt_exe):
            pip_python = alt_exe

    try:
        res = subprocess.run(
            [pip_python, "-m", "pip", "install", "-r", req_file],
            capture_output=True,
            text=True,
            timeout=300
        )
        return {
            "status": "success" if res.returncode == 0 else "warning",
            "returncode": res.returncode,
            "stdout": res.stdout,
            "stderr": res.stderr
        }
    except Exception as e:
        return {"status": "error", "message": str(e)}


def find_backend_dir(extracted_root):
    """
    Locates the backend (non-vba) folder inside an extracted repository archive.
    """
    def is_backend_dir(path):
        markers = ["app.py", "updater.py", "requirements.txt", "version.json"]
        return any(os.path.exists(os.path.join(path, m)) for m in markers)

    target_backend = os.path.join(extracted_root, "backend")
    if is_backend_dir(target_backend):
        return target_backend

    for entry in os.listdir(extracted_root):
        full_entry = os.path.join(extracted_root, entry)
        if os.path.isdir(full_entry):
            sub_backend = os.path.join(full_entry, "backend")
            if is_backend_dir(sub_backend):
                return sub_backend
            if is_backend_dir(full_entry):
                return full_entry

    if is_backend_dir(extracted_root):
        return extracted_root

    return extracted_root


def download_update_archive(url, destination_file):
    req = urllib.request.Request(
        url,
        headers={"User-Agent": "CorelDraw-AI-Agent-Updater/1.0"}
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        with open(destination_file, "wb") as f:
            shutil.copyfileobj(resp, f)


def apply_update(source_path=None, target_version=None):
    """
    Applies update from GitHub or local source_path (zip file or directory).
    1. Downloads archive from GitHub if source_path is not provided.
    2. Creates a backup of current backend.
    3. Replaces non-VBA part (backend directory) automatically preserving user config & .venv.
    4. Runs pip install -r requirements.txt.
    5. Saves updated version.json.
    """
    info = load_version_info()
    backend_dir = os.path.dirname(os.path.abspath(__file__))
    os.makedirs(BACKUPS_DIR, exist_ok=True)

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    backup_folder = os.path.join(BACKUPS_DIR, f"backup_v{info['version']}_{timestamp}")
    os.makedirs(backup_folder, exist_ok=True)

    # 1. Backup current non-vba files (excluding .venv and backups)
    for item in os.listdir(backend_dir):
        if item in {".venv", "backups"}:
            continue
        src = os.path.join(backend_dir, item)
        dst = os.path.join(backup_folder, item)
        if os.path.isdir(src):
            shutil.copytree(src, dst, dirs_exist_ok=True)
        else:
            shutil.copy2(src, dst)

    # 2. Extract update source or download from GitHub
    with tempfile.TemporaryDirectory() as temp_dir:
        source_backend = None

        if source_path and os.path.exists(source_path):
            if zipfile.is_zipfile(source_path):
                extract_dir = os.path.join(temp_dir, "extracted")
                with zipfile.ZipFile(source_path, "r") as zip_ref:
                    zip_ref.extractall(extract_dir)
                source_backend = find_backend_dir(extract_dir)
            elif os.path.isdir(source_path):
                source_backend = find_backend_dir(source_path)
        else:
            # Download from GitHub
            download_url = info.get("download_url") or get_default_version_data()["download_url"]
            zip_dest = os.path.join(temp_dir, "update.zip")
            try:
                download_update_archive(download_url, zip_dest)
                extract_dir = os.path.join(temp_dir, "extracted")
                with zipfile.ZipFile(zip_dest, "r") as zip_ref:
                    zip_ref.extractall(extract_dir)
                source_backend = find_backend_dir(extract_dir)
            except Exception as e:
                return {
                    "status": "error",
                    "message": f"Не удалось загрузить обновление с GitHub ({download_url}): {str(e)}"
                }

        new_ver = target_version or info.get("latest_version")
        if not new_ver or new_ver == info.get("version"):
            src_ver_file = os.path.join(source_backend, "version.json")
            if os.path.exists(src_ver_file):
                try:
                    with open(src_ver_file, "r", encoding="utf-8") as vf:
                        vdata = json.load(vf)
                        new_ver = vdata.get("version") or new_ver
                except Exception:
                    pass
        if not new_ver:
            new_ver = "1.1.0"

        # 3. Clean up orphaned non-preserved files/directories in backend_dir first
        for item in os.listdir(backend_dir):
            if item in PRESERVE_FILES:
                continue
            item_path = os.path.join(backend_dir, item)
            try:
                if os.path.isdir(item_path):
                    shutil.rmtree(item_path)
                else:
                    os.remove(item_path)
            except Exception as e:
                print(f"Cleanup error for {item}:", e)

        # 4. Copy items from source_backend to backend_dir
        for item in os.listdir(source_backend):
            if item in PRESERVE_FILES:
                continue
            src_item = os.path.join(source_backend, item)
            dst_item = os.path.join(backend_dir, item)

            if os.path.isdir(src_item):
                shutil.copytree(src_item, dst_item)
            else:
                shutil.copy2(src_item, dst_item)

    # 5. Run pip install -r requirements.txt
    pip_res = run_pip_install(backend_dir)

    # 6. Update version.json info
    info["version"] = new_ver
    info["update_available"] = False
    info["latest_version"] = new_ver
    info["release_notes"] = ""
    info["last_updated"] = datetime.now().isoformat()
    info["last_backup"] = backup_folder
    save_version_info(info)

    return {
        "status": "success",
        "version": new_ver,
        "backup": backup_folder,
        "pip": pip_res
    }


def rollback_update():
    info = load_version_info()
    last_backup = info.get("last_backup")

    if not last_backup or not os.path.exists(last_backup):
        if os.path.exists(BACKUPS_DIR):
            backups = sorted(
                [
                    os.path.join(BACKUPS_DIR, d)
                    for d in os.listdir(BACKUPS_DIR)
                    if os.path.isdir(os.path.join(BACKUPS_DIR, d))
                ]
            )
            if backups:
                last_backup = backups[-1]

    if not last_backup or not os.path.exists(last_backup):
        raise ValueError("Нет сохраненных резервных копий для отката.")

    backend_dir = os.path.dirname(os.path.abspath(__file__))

    # Clean up orphaned non-preserved files in backend_dir first
    for item in os.listdir(backend_dir):
        if item in PRESERVE_FILES:
            continue
        item_path = os.path.join(backend_dir, item)
        try:
            if os.path.isdir(item_path):
                shutil.rmtree(item_path)
            else:
                os.remove(item_path)
        except Exception as e:
            print(f"Cleanup error for {item}:", e)

    for item in os.listdir(last_backup):
        if item in PRESERVE_FILES:
            continue
        src_item = os.path.join(last_backup, item)
        dst_item = os.path.join(backend_dir, item)

        if os.path.isdir(src_item):
            shutil.copytree(src_item, dst_item)
        else:
            shutil.copy2(src_item, dst_item)

    backup_name = os.path.basename(last_backup)
    restored_version = "1.0.0"
    if "backup_v" in backup_name:
        try:
            restored_version = backup_name.split("backup_v")[1].split("_")[0]
        except Exception:
            pass

    pip_res = run_pip_install(backend_dir)

    info["version"] = restored_version
    info["update_available"] = False
    info["latest_version"] = restored_version
    info["last_updated"] = datetime.now().isoformat()
    save_version_info(info)

    return {
        "status": "success",
        "version": restored_version,
        "restored_from": last_backup,
        "pip": pip_res
    }


def restart_backend(backend_dir=None):
    """
    Restarts the backend process using venv python.
    """
    if backend_dir is None:
        backend_dir = os.path.dirname(os.path.abspath(__file__))

    app_py = os.path.join(backend_dir, "app.py")
    python_exe = get_venv_python(backend_dir)

    cmd = [python_exe, app_py]

    if os.name == "nt":
        DETACHED_PROCESS = 0x00000008
        CREATE_NEW_PROCESS_GROUP = 0x00000200
        subprocess.Popen(
            cmd,
            cwd=backend_dir,
            creationflags=DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
        )
    else:
        subprocess.Popen(cmd, cwd=backend_dir, start_new_session=True)


def schedule_restart(delay=1.0, backend_dir=None):
    """
    Schedules backend restart after specified delay (in seconds).
    """
    def _do_restart():
        time.sleep(delay)
        try:
            restart_backend(backend_dir)
        except Exception as e:
            print(f"Error during backend restart: {e}")
        os._exit(0)

    t = threading.Thread(target=_do_restart)
    t.daemon = True
    t.start()

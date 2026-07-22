import os
import json
from anti_client import Client
from config import (
    MULTI_ACCOUNTS_FILE,
    OAUTH_CONFIG_FILE,
    atomic_write_json,
    read_json_locked,
)


def load_oauth_config():
    return read_json_locked(OAUTH_CONFIG_FILE, default_factory=dict)


def save_oauth_config(data):
    atomic_write_json(OAUTH_CONFIG_FILE, data)


def load_accounts():
    default_data = {"accounts": [], "current_index": -1}
    data = read_json_locked(MULTI_ACCOUNTS_FILE, default_factory=lambda: default_data)
    if isinstance(data, dict):
        if "accounts" not in data or not isinstance(data.get("accounts"), list):
            data["accounts"] = []
        if "current_index" not in data or not isinstance(data.get("current_index"), int):
            data["current_index"] = -1
        return data
    return default_data


def save_accounts(data):
    atomic_write_json(MULTI_ACCOUNTS_FILE, data)


def get_current_client():
    data = load_accounts()
    idx = data.get("current_index", -1)
    if 0 <= idx < len(data["accounts"]):
        acc = data["accounts"][idx]

        # Sync the active account to the global accounts.json for anti_client
        data_dir = os.environ.get("ANTI_API_DATA_DIR")
        if not data_dir:
            home = (
                os.environ.get("HOME")
                or os.environ.get("USERPROFILE")
                or os.path.expanduser("~")
            )
            data_dir = os.path.join(home, ".anti-api")
        acc_file = os.path.join(data_dir, "accounts.json")
        os.makedirs(data_dir, exist_ok=True)
        try:
            with open(acc_file, "w", encoding="utf-8") as f:
                json.dump({"accounts": [acc]}, f)
        except Exception:
            pass

        try:
            return Client()
        except Exception:
            pass
    try:
        return Client()
    except Exception:
        return None

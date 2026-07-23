import json
import os
import tempfile
import threading

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CONFIG_FILE = os.path.join(BASE_DIR, "config.json")

DEFAULT_CONFIG = {
    "ai_model": "gemini-3.1-pro-low",
    "server_host": "127.0.0.1",
    "server_port": 5055,
    "browser_emulation_version": 11001,
    "max_svg_char_limit": 6000,
    "model_hover_delay_ms": 1200,
    "update_url": "https://raw.githubusercontent.com/Makobcki/cdraw-ext/main/backend/version.json",
    "download_url": "https://github.com/Makobcki/cdraw-ext/archive/refs/heads/main.zip",
    "model_blacklist_display_name_keywords": ["image"],
    "model_blacklist_api_name_keywords": ["agent"],
    "model_blacklist_keywords": ["chat_", "flash_lite", "2.5 pro", "flash lite"],
    "system_prompt_file": "system_prompt.md",
    "preserve_files": [
        ".venv",
        "backups",
        "oauth_config.json",
        "multi_accounts.json",
        ".env",
        "version.json",
        "chats.json",
        "hidden_models.json",
        "config.json",
        "system_prompt.md",
    ],
    "shared_temp_dir": os.path.join(os.environ.get("TEMP", "C:\\Temp"), "cdr_ai_agent"),
}


def load_config():
    conf = dict(DEFAULT_CONFIG)
    if os.path.exists(CONFIG_FILE):
        try:
            with open(CONFIG_FILE, "r", encoding="utf-8") as f:
                content = f.read().strip()
                if content:
                    loaded = json.loads(content)
                    conf.update(loaded)
        except Exception as e:
            print(f"Error loading {CONFIG_FILE}:", e)
    return conf


_loaded_cfg = load_config()

MODEL_BLACKLIST_DISPLAY_NAME_KEYWORDS = _loaded_cfg.get(
    "model_blacklist_display_name_keywords", DEFAULT_CONFIG["model_blacklist_display_name_keywords"]
)
MODEL_BLACKLIST_API_NAME_KEYWORDS = _loaded_cfg.get(
    "model_blacklist_api_name_keywords", DEFAULT_CONFIG["model_blacklist_api_name_keywords"]
)
MODEL_BLACKLIST_KEYWORDS = _loaded_cfg.get(
    "model_blacklist_keywords", DEFAULT_CONFIG["model_blacklist_keywords"]
)

AI_MODEL = os.environ.get(
    "AI_MODEL", _loaded_cfg.get("ai_model", DEFAULT_CONFIG["ai_model"])
)

SYSTEM_PROMPT_FILE = os.path.join(
    BASE_DIR, _loaded_cfg.get("system_prompt_file", "system_prompt.md")
)


def load_system_prompt():
    if os.path.exists(SYSTEM_PROMPT_FILE):
        try:
            with open(SYSTEM_PROMPT_FILE, "r", encoding="utf-8") as f:
                content = f.read().strip()
                if content:
                    return content
        except Exception as e:
            print(f"Error reading {SYSTEM_PROMPT_FILE}:", e)
    return _loaded_cfg.get("system_prompt", "")


SYSTEM_PROMPT = load_system_prompt()

SERVER_HOST = os.environ.get("SERVER_HOST", _loaded_cfg.get("server_host", 5055))
SERVER_PORT = int(os.environ.get("SERVER_PORT", _loaded_cfg.get("server_port", 5055)))
BROWSER_EMULATION_VERSION = int(
    _loaded_cfg.get("browser_emulation_version", DEFAULT_CONFIG["browser_emulation_version"])
)
MAX_SVG_CHAR_LIMIT = int(
    _loaded_cfg.get("max_svg_char_limit", DEFAULT_CONFIG["max_svg_char_limit"])
)
MODEL_HOVER_DELAY_MS = int(
    _loaded_cfg.get("model_hover_delay_ms", DEFAULT_CONFIG["model_hover_delay_ms"])
)
UPDATE_URL = _loaded_cfg.get("update_url", DEFAULT_CONFIG["update_url"])
DOWNLOAD_URL = _loaded_cfg.get("download_url", DEFAULT_CONFIG["download_url"])
PRESERVE_FILES = set(_loaded_cfg.get("preserve_files", DEFAULT_CONFIG["preserve_files"]))

SHARED_TEMP_DIR = os.environ.get(
    "CDR_AGENT_TEMP",
    _loaded_cfg.get("shared_temp_dir", DEFAULT_CONFIG["shared_temp_dir"]),
)
os.makedirs(SHARED_TEMP_DIR, exist_ok=True)

HIDDEN_MODELS_FILE = os.path.join(BASE_DIR, "hidden_models.json")
STATIC_DIR = os.path.join(BASE_DIR, "static")
MULTI_ACCOUNTS_FILE = os.path.join(BASE_DIR, "multi_accounts.json")
OAUTH_CONFIG_FILE = os.path.join(BASE_DIR, "oauth_config.json")
CHATS_FILE = os.path.join(BASE_DIR, "chats.json")


def is_blacklisted_model(model_id, display_name=""):
    mid = str(model_id).lower()
    dname = str(display_name).lower()

    for kw in MODEL_BLACKLIST_DISPLAY_NAME_KEYWORDS:
        if kw.lower() in dname:
            return True

    for kw in MODEL_BLACKLIST_API_NAME_KEYWORDS:
        if kw.lower() in mid:
            return True

    for kw in MODEL_BLACKLIST_KEYWORDS:
        kw_lower = kw.lower()
        if kw_lower in mid or kw_lower in dname:
            return True
        kw_dash = kw_lower.replace(" ", "-")
        kw_underscore = kw_lower.replace(" ", "_")
        if kw_dash in mid or kw_dash in dname:
            return True
        if kw_underscore in mid or kw_underscore in dname:
            return True
    return False


# ---------------------------------------------------------------------
# Потокобезопасная и атомарная работа с локальными JSON-файлами
# ---------------------------------------------------------------------

_FILE_LOCK = threading.Lock()


def atomic_write_json(file_path, data):
    with _FILE_LOCK:
        dir_name = os.path.dirname(os.path.abspath(file_path))
        os.makedirs(dir_name, exist_ok=True)
        tmp_fd, tmp_path = tempfile.mkstemp(
            dir=dir_name, prefix=".tmp_", suffix=".json"
        )
        try:
            with os.fdopen(tmp_fd, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
            os.replace(tmp_path, file_path)
        except Exception as e:
            if os.path.exists(tmp_path):
                os.remove(tmp_path)
            raise e


def read_json_locked(file_path, default_factory=dict):
    with _FILE_LOCK:
        if os.path.exists(file_path):
            try:
                with open(file_path, "r", encoding="utf-8") as f:
                    content = f.read().strip()
                    if content:
                        return json.loads(content)
            except Exception as e:
                print(f"Error reading {file_path}:", e)
        return default_factory()

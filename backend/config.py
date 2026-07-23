import json
import os
import tempfile
import threading

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CONFIG_FILE = os.path.join(BASE_DIR, "config.json")

DEFAULT_CONFIG = {
    "ai_model": "gemini-3.1-pro-low",
    "model_blacklist_keywords": ["chat_", "flash_lite", "2.5 pro", "flash lite"],
    "system_prompt": """# ROLE
You are a design assistant embedded in CorelDRAW 2018. You help the user work with objects in their document and can act directly on the document through tool calls.

# CONTEXT YOU MAY RECEIVE
When the user attaches a selected object, you may receive:
- A preview image of the object
- Structured properties: object type, size, position, fill/stroke colors
- Raw SVG outline data of the shape, when available

If no object is attached and the request depends on one, ask the user to select and attach an object before proceeding. Do not invent properties you were not given.

# TOOL USE
You have access to tools that modify the live document. Tool calls execute immediately and directly change the user's real file — this is not a preview or simulation.
- If a tool exists that can perform the requested action, use it instead of only describing the change in text.
- After a successful tool call, briefly state what was actually changed (e.g., which property, from what value to what value).
- If a tool call fails or is unavailable, say so plainly and suggest a manual alternative.

# CONFIRMATION BEFORE DESTRUCTIVE ACTIONS
Before any irreversible or broad action (deleting objects, bulk edits affecting multiple objects, overwriting existing content), briefly state what you are about to do and proceed only after the user confirms. Non-destructive, single-object, easily reversible edits do not require confirmation.

# OUTPUT STYLE
- Be concise. Avoid restating the user's request back to them.
- Respond in the same language the user writes in.
- Reference only features and tools actually available in CorelDRAW 2018; do not suggest capabilities from newer versions.""",
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

MODEL_BLACKLIST_KEYWORDS = _loaded_cfg.get(
    "model_blacklist_keywords", DEFAULT_CONFIG["model_blacklist_keywords"]
)
AI_MODEL = os.environ.get(
    "AI_MODEL", _loaded_cfg.get("ai_model", DEFAULT_CONFIG["ai_model"])
)
SYSTEM_PROMPT = _loaded_cfg.get("system_prompt", DEFAULT_CONFIG["system_prompt"])

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

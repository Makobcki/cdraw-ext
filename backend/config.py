import os
import json
import tempfile
import threading

AI_MODEL = os.environ.get("AI_MODEL", "gemini-2.5-pro")

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

HIDDEN_MODELS_FILE = os.path.join(BASE_DIR, "hidden_models.json")
STATIC_DIR = os.path.join(BASE_DIR, "static")
MULTI_ACCOUNTS_FILE = os.path.join(BASE_DIR, "multi_accounts.json")
OAUTH_CONFIG_FILE = os.path.join(BASE_DIR, "oauth_config.json")
CHATS_FILE = os.path.join(BASE_DIR, "chats.json")

SHARED_TEMP_DIR = os.environ.get(
    "CDR_AGENT_TEMP", os.path.join(os.environ.get("TEMP", "C:\\Temp"), "cdr_ai_agent")
)
os.makedirs(SHARED_TEMP_DIR, exist_ok=True)

SYSTEM_PROMPT = (
    "Ты — ассистент по дизайну, встроенный в CorelDRAW 2018. "
    "Пользователь может прикрепить к сообщению выделенный объект — ты получишь "
    "его превью (картинку), структурированные свойства (тип, размер, "
    "позиция, цвета) и, если доступно, исходные SVG-данные контура. "
    "Ты можешь не только советовать, но и вносить изменения в документ через "
    "вызов инструментов (tools) — они выполняются немедленно в реальном "
    "документе пользователя. После успешного вызова инструмента коротко "
    "поясняй, что именно изменилось. Перед разрушительными действиями "
    "(удаление, массовые правки) кратко уточняй, что собираешься сделать."
)

# ---------------------------------------------------------------------
# Потокобезопасная и атомарная работа с локальными JSON-файлами
# ---------------------------------------------------------------------

_FILE_LOCK = threading.Lock()


def atomic_write_json(file_path, data):
    with _FILE_LOCK:
        dir_name = os.path.dirname(os.path.abspath(file_path))
        os.makedirs(dir_name, exist_ok=True)
        tmp_fd, tmp_path = tempfile.mkstemp(dir=dir_name, prefix=".tmp_", suffix=".json")
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

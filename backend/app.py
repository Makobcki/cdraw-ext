import asyncio
import base64
import json
import os
import threading
import uuid
import updater

from anti_client import Client, Message, Tool, ToolCall, FileAttachment
from flask import (
    Flask,
    Response,
    jsonify,
    request,
    send_from_directory,
    stream_with_context,
)

# ---------------------------------------------------------------------
# Конфигурация
# ---------------------------------------------------------------------

AI_MODEL = os.environ.get("AI_MODEL", "gemini-2.5-pro")
HIDDEN_MODELS_FILE = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "hidden_models.json"
)


def load_hidden_models():
    if os.path.exists(HIDDEN_MODELS_FILE):
        try:
            with open(HIDDEN_MODELS_FILE, "r", encoding="utf-8") as f:
                return set(json.load(f))
        except:
            pass
    return set()


def save_hidden_models(hidden_set):
    with open(HIDDEN_MODELS_FILE, "w", encoding="utf-8") as f:
        json.dump(list(hidden_set), f)


_cached_models = None


def get_all_models(bypass_cache=False):
    global _cached_models
    if not bypass_cache and _cached_models is not None:
        return _cached_models
    try:
        client = Client()
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        models = loop.run_until_complete(client.models.list())
        parsed = []
        for m in models:
            quota_pct = None
            q = getattr(m, "quota_info", None)
            if (
                q
                and hasattr(q, "remaining_fraction")
                and q.remaining_fraction is not None
            ):
                quota_pct = round(q.remaining_fraction * 100)
            parsed.append(
                {
                    "id": str(m.id).strip(),
                    "display_name": (
                        str(m.display_name).strip()
                        if m.display_name
                        else str(m.id).strip()
                    ),
                    "quota_pct": quota_pct,
                }
            )
        parsed.sort(key=lambda x: x["display_name"].lower())
        _cached_models = parsed
        return _cached_models
    except Exception as e:
        print("Error fetching models:", e)
        return [{"id": AI_MODEL, "display_name": AI_MODEL, "quota_pct": None}]


SHARED_TEMP_DIR = os.environ.get(
    "CDR_AGENT_TEMP", os.path.join(os.environ.get("TEMP", "C:\\Temp"), "cdr_ai_agent")
)
os.makedirs(SHARED_TEMP_DIR, exist_ok=True)

STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")
MULTI_ACCOUNTS_FILE = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "multi_accounts.json"
)
OAUTH_CONFIG_FILE = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "oauth_config.json"
)

app = Flask(__name__, static_folder=None)


def load_oauth_config():
    if os.path.exists(OAUTH_CONFIG_FILE):
        with open(OAUTH_CONFIG_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    return {}


def save_oauth_config(data):
    with open(OAUTH_CONFIG_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f)


def load_accounts():
    if os.path.exists(MULTI_ACCOUNTS_FILE):
        with open(MULTI_ACCOUNTS_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    return {"accounts": [], "current_index": -1}


def save_accounts(data):
    with open(MULTI_ACCOUNTS_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)


def get_current_client():
    data = load_accounts()
    idx = data.get("current_index", -1)
    if 0 <= idx < len(data["accounts"]):
        acc = data["accounts"][idx]
        
        # Sync the active account to the global accounts.json for anti_client
        data_dir = os.environ.get("ANTI_API_DATA_DIR")
        if not data_dir:
            home = os.environ.get("HOME") or os.environ.get("USERPROFILE") or os.path.expanduser("~")
            data_dir = os.path.join(home, ".anti-api")
        acc_file = os.path.join(data_dir, "accounts.json")
        os.makedirs(data_dir, exist_ok=True)
        try:
            with open(acc_file, "w", encoding="utf-8") as f:
                json.dump({"accounts": [acc]}, f)
        except Exception:
            pass

        try:
            # Client() will now read the correctly synced account from ~/.anti-api/accounts.json
            return Client()
        except Exception:
            pass
    try:
        return Client()
    except Exception:
        return None


client = get_current_client()

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
# Схема инструментов (anti_client Tool objects)
# ---------------------------------------------------------------------

TOOLS = [
    Tool(
        name="set_fill_color",
        description="Задать сплошную заливку объекта.",
        parameters={
            "type": "object",
            "properties": {
                "ref": {"type": "string", "description": "Идентификатор объекта"},
                "hex_color": {
                    "type": "string",
                    "description": "Цвет в формате #RRGGBB",
                },
            },
            "required": ["ref", "hex_color"],
        },
    ),
    Tool(
        name="set_position",
        description="Переместить объект в абсолютные координаты страницы.",
        parameters={
            "type": "object",
            "properties": {
                "ref": {"type": "string"},
                "x": {"type": "number"},
                "y": {"type": "number"},
            },
            "required": ["ref", "x", "y"],
        },
    ),
    Tool(
        name="set_size",
        description="Задать ширину и высоту объекта.",
        parameters={
            "type": "object",
            "properties": {
                "ref": {"type": "string"},
                "width": {"type": "number"},
                "height": {"type": "number"},
            },
            "required": ["ref", "width", "height"],
        },
    ),
    Tool(
        name="rotate",
        description="Повернуть объект на заданный угол в градусах.",
        parameters={
            "type": "object",
            "properties": {
                "ref": {"type": "string"},
                "angle": {"type": "number"},
            },
            "required": ["ref", "angle"],
        },
    ),
    Tool(
        name="duplicate",
        description="Продублировать объект. Возвращает ref новой копии.",
        parameters={
            "type": "object",
            "properties": {"ref": {"type": "string"}},
            "required": ["ref"],
        },
    ),
    Tool(
        name="delete_shape",
        description="Удалить объект из документа.",
        parameters={
            "type": "object",
            "properties": {"ref": {"type": "string"}},
            "required": ["ref"],
        },
    ),
    Tool(
        name="convert_to_curves",
        description="Преобразовать объект в кривые перед точечным редактированием контура.",
        parameters={
            "type": "object",
            "properties": {"ref": {"type": "string"}},
            "required": ["ref"],
        },
    ),
    Tool(
        name="order",
        description="Изменить порядок наложения объекта.",
        parameters={
            "type": "object",
            "properties": {
                "ref": {"type": "string"},
                "mode": {
                    "type": "string",
                    "enum": ["front", "back", "forward", "backward"],
                },
            },
            "required": ["ref", "mode"],
        },
    ),
    Tool(
        name="export_svg",
        description="Получить актуальные векторные SVG-данные объекта.",
        parameters={
            "type": "object",
            "properties": {"ref": {"type": "string"}},
            "required": ["ref"],
        },
    ),
    Tool(
        name="import_svg",
        description="Создать новый объект из SVG-разметки.",
        parameters={
            "type": "object",
            "properties": {
                "svg": {"type": "string", "description": "Полная SVG-разметка"},
                "x": {"type": "number"},
                "y": {"type": "number"},
            },
            "required": ["svg"],
        },
    ),
    Tool(
        name="trace_bitmap",
        description=(
            "Трассировать (векторизовать) растровое изображение — PowerTRACE. "
            "Результат появляется поверх оригинала и возвращается как new_refs; "
            "исходный битмап по умолчанию не удаляется."
        ),
        parameters={
            "type": "object",
            "properties": {
                "ref": {
                    "type": "string",
                    "description": "Идентификатор растрового объекта",
                },
                "style": {
                    "type": "string",
                    "enum": [
                        "line_art",
                        "logo",
                        "detailed_logo",
                        "clipart",
                        "low_quality_image",
                        "high_quality_image",
                        "technical",
                        "line_drawing",
                    ],
                    "description": "Пресет трассировки (соответствует стилям PowerTRACE)",
                },
            },
            "required": ["ref", "style"],
        },
    ),
    Tool(
        name="get_page_info",
        description="Узнать размер текущей страницы/листа — для расчёта эффективного размещения объектов.",
        parameters={"type": "object", "properties": {}, "required": []},
    ),
]

CHATS = {"default": {"title": "Новый чат", "messages": []}}
CURRENT_CHAT_ID = "default"


def stream_agent_loop():
    yield (" " * 2048 + "\n").encode("utf-8")
    if client is None:
        yield (
            json.dumps(
                {
                    "type": "error",
                    "error": "Пожалуйста, авторизуйтесь (добавьте аккаунт) для продолжения.",
                },
                ensure_ascii=False,
            )
            + "\n"
        ).encode("utf-8")
        return

    chat_messages = CHATS.get(CURRENT_CHAT_ID, {}).get("messages", [])
    messages = [Message(role="system", content=SYSTEM_PROMPT)] + chat_messages

    loop = asyncio.new_event_loop()

    async def get_stream():
        return await client.generate(
            model=AI_MODEL, messages=messages, tools=TOOLS, stream=True
        )

    try:
        gen = loop.run_until_complete(get_stream())
    except Exception as e:
        yield (json.dumps({"type": "error", "error": str(e)}, ensure_ascii=False) + "\n").encode("utf-8")
        loop.close()
        return

    full_text = ""
    has_tools = False

    while True:
        try:
            chunk = loop.run_until_complete(gen.__anext__())
            if isinstance(chunk, str):
                full_text += chunk
                yield (
                    json.dumps({"type": "chunk", "text": chunk}, ensure_ascii=False)
                    + "\n"
                ).encode("utf-8")
            elif isinstance(chunk, list):  # list of ToolCall
                has_tools = True
                calls = [
                    {"id": tc.id, "name": tc.name, "arguments": tc.arguments}
                    for tc in chunk
                ]
                if CURRENT_CHAT_ID in CHATS:
                    CHATS[CURRENT_CHAT_ID]["messages"].append(
                        Message(
                            role="assistant",
                            content=full_text if full_text else None,
                            tool_calls=chunk,
                        )
                    )
                yield (
                    json.dumps(
                        {"type": "tool_calls", "calls": calls}, ensure_ascii=False
                    )
                    + "\n"
                ).encode("utf-8")
        except StopAsyncIteration:
            break
        except Exception as e:
            yield (
                json.dumps({"type": "error", "error": str(e)}, ensure_ascii=False)
                + "\n"
            ).encode("utf-8")
            break

    if not has_tools and full_text:
        if CURRENT_CHAT_ID in CHATS:
            CHATS[CURRENT_CHAT_ID]["messages"].append(
                Message(role="assistant", content=full_text)
            )

    # Send a done marker in case the frontend needs it, though the connection closes anyway
    yield (json.dumps({"type": "done"}, ensure_ascii=False) + "\n").encode("utf-8")

    loop.close()


# ---------------------------------------------------------------------
# Маршруты
# ---------------------------------------------------------------------


@app.route("/health", methods=["GET"])
def health():
    return jsonify({"ok": True})


@app.route("/", methods=["GET"])
def index():
    return send_from_directory(STATIC_DIR, "index.html")


@app.route("/static/<path:filename>", methods=["GET"])
def static_files(filename):
    return send_from_directory(STATIC_DIR, filename)


# ---------------------------------------------------------------------
# Автообновление (Auto-updater)
# ---------------------------------------------------------------------

@app.route("/updater/status", methods=["GET"])
def updater_status():
    info = updater.load_version_info()
    return jsonify(info)


@app.route("/updater/check", methods=["POST"])
def updater_check():
    data = request.get_json(silent=True) or {}
    mock_version = data.get("mock_version")
    info = updater.check_for_updates(mock_version=mock_version)
    return jsonify(info)


@app.route("/updater/settings", methods=["POST"])
def updater_settings():
    data = request.get_json(force=True)
    info = updater.load_version_info()
    if "auto_check" in data:
        info["auto_check"] = bool(data["auto_check"])
    if "update_url" in data and data["update_url"]:
        info["update_url"] = str(data["update_url"]).strip()
    updater.save_version_info(info)
    return jsonify(info)


@app.route("/updater/apply", methods=["POST"])
def updater_apply():
    data = request.get_json(silent=True) or {}
    target_version = data.get("target_version")
    source_path = data.get("source_path")
    do_restart = data.get("restart", True)
    res = updater.apply_update(source_path=source_path, target_version=target_version)
    if res.get("status") == "success" and do_restart:
        updater.schedule_restart(delay=1.0)
    return jsonify(res)


@app.route("/updater/rollback", methods=["POST"])
def updater_rollback():
    data = request.get_json(silent=True) or {}
    do_restart = data.get("restart", True)
    try:
        res = updater.rollback_update()
        if res.get("status") == "success" and do_restart:
            updater.schedule_restart(delay=1.0)
        return jsonify(res)
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 400


@app.route("/settings/model", methods=["GET", "POST", "DELETE"])
def settings_model():
    global AI_MODEL
    if request.method == "GET":
        all_models = get_all_models()
        hidden = load_hidden_models()
        visible_models = [m for m in all_models if m["id"] not in hidden]
        if not visible_models and all_models:
            visible_models = all_models
            hidden = set()
            save_hidden_models(hidden)
        if AI_MODEL in hidden or not any(m["id"] == AI_MODEL for m in visible_models):
            if visible_models:
                AI_MODEL = visible_models[0]["id"]
        return jsonify({"current_model": AI_MODEL, "available_models": visible_models})
    elif request.method == "POST":
        data = request.get_json(silent=True) or {}
        new_model = data.get("model")
        if new_model:
            AI_MODEL = new_model
            return jsonify({"status": "ok", "current_model": AI_MODEL})
        return jsonify({"error": "Invalid model"}), 400
    elif request.method == "DELETE":
        data = request.get_json(silent=True) or {}
        model_to_hide = data.get("model")
        if model_to_hide:
            hidden = load_hidden_models()
            hidden.add(model_to_hide)

            all_models = get_all_models()
            visible_models = [m for m in all_models if m["id"] not in hidden]

            if not visible_models and all_models:
                hidden = set()
                visible_models = all_models

            save_hidden_models(hidden)

            if AI_MODEL == model_to_hide or AI_MODEL in hidden or not any(m["id"] == AI_MODEL for m in visible_models):
                if visible_models:
                    AI_MODEL = visible_models[0]["id"]

            return jsonify({"status": "ok", "current_model": AI_MODEL, "available_models": visible_models})
        return jsonify({"error": "Invalid model"}), 400


@app.route("/settings/model/reset", methods=["POST"])
def reset_models():
    global _cached_models, AI_MODEL
    if os.path.exists(HIDDEN_MODELS_FILE):
        try:
            os.remove(HIDDEN_MODELS_FILE)
        except:
            pass
    _cached_models = None
    all_models = get_all_models(bypass_cache=True)
    if all_models and not any(m["id"] == AI_MODEL for m in all_models):
        AI_MODEL = all_models[0]["id"]
    return jsonify({"status": "ok", "current_model": AI_MODEL, "available_models": all_models})


@app.route("/auth/oauth_config", methods=["GET", "POST"])
def oauth_config():
    if request.method == "GET":
        conf = load_oauth_config()
        return jsonify(
            {
                "client_id": conf.get("client_id", ""),
                "client_secret": conf.get("client_secret", ""),
            }
        )
    else:
        data = request.json
        save_oauth_config(data)
        return jsonify({"status": "ok"})


@app.route("/auth/status", methods=["GET"])
def auth_status():
    data = load_accounts()
    safe_accounts = [
        {"id": i, "name": acc.get("name", f"Account {i + 1}")}
        for i, acc in enumerate(data["accounts"])
    ]
    is_authed = client is not None
    return jsonify(
        {
            "accounts": safe_accounts,
            "current_index": data.get("current_index", -1),
            "is_authenticated": is_authed,
        }
    )


@app.route("/auth/login", methods=["POST"])
def auth_login():
    import anti_client.client

    def do_login():
        import subprocess
        import sys
        try:
            subprocess.run(
                [sys.executable, "-c", "import anti_client.client; anti_client.client.authenticate()"],
                check=True
            )
        except Exception as e:
            print("Login error:", e)
            return

        data_dir = os.environ.get("ANTI_API_DATA_DIR")
        if not data_dir:
            home = (
                os.environ.get("HOME")
                or os.environ.get("USERPROFILE")
                or os.path.expanduser("~")
            )
            data_dir = os.path.join(home, ".anti-api")
        acc_file = os.path.join(data_dir, "accounts.json")

        if os.path.exists(acc_file):
            with open(acc_file, "r", encoding="utf-8") as f:
                d = json.load(f)
                if d.get("accounts"):
                    new_acc = d["accounts"][0]
                    m_data = load_accounts()
                    new_acc["name"] = f"Account {len(m_data['accounts']) + 1}"
                    m_data["accounts"].append(new_acc)
                    m_data["current_index"] = len(m_data["accounts"]) - 1
                    save_accounts(m_data)
                    global client
                    client = get_current_client()

    threading.Thread(target=do_login).start()
    return jsonify({"status": "started"})


@app.route("/auth/switch", methods=["POST"])
def auth_switch():
    idx = request.json.get("index", -1)
    data = load_accounts()
    if 0 <= idx < len(data["accounts"]):
        data["current_index"] = idx
        save_accounts(data)
        global client
        client = get_current_client()
        return jsonify({"status": "ok"})
    return jsonify({"error": "Invalid index"}), 400


@app.route("/auth/rename", methods=["POST"])
def auth_rename():
    idx = request.json.get("index", -1)
    new_name = request.json.get("name", "").strip()
    if not new_name:
        return jsonify({"error": "Name cannot be empty"}), 400
    data = load_accounts()
    if 0 <= idx < len(data["accounts"]):
        data["accounts"][idx]["name"] = new_name
        save_accounts(data)
        return jsonify({"status": "ok"})
    return jsonify({"error": "Invalid index"}), 400


@app.route("/auth/logout", methods=["POST"])
def auth_logout():
    idx = request.json.get("index", -1)
    data = load_accounts()
    if 0 <= idx < len(data["accounts"]):
        data["accounts"].pop(idx)
        if data["current_index"] == idx:
            data["current_index"] = 0 if data["accounts"] else -1
        elif data["current_index"] > idx:
            data["current_index"] -= 1
        save_accounts(data)
        global client
        client = get_current_client()
        return jsonify({"status": "ok"})
    return jsonify({"error": "Invalid index"}), 400


@app.route("/chats", methods=["GET"])
def get_chats():
    chat_list = [{"id": cid, "title": cdata["title"]} for cid, cdata in CHATS.items()]
    return jsonify({"chats": chat_list, "current_id": CURRENT_CHAT_ID})


@app.route("/chats/new", methods=["POST"])
def new_chat():
    global CURRENT_CHAT_ID
    new_id = uuid.uuid4().hex
    CHATS[new_id] = {"title": "Новый чат", "messages": []}
    CURRENT_CHAT_ID = new_id
    return jsonify({"id": new_id})


@app.route("/chats/switch", methods=["POST"])
def switch_chat():
    global CURRENT_CHAT_ID
    chat_id = request.json.get("id")
    if chat_id in CHATS:
        CURRENT_CHAT_ID = chat_id
        return jsonify({"status": "ok"})
    return jsonify({"error": "Chat not found"}), 404


@app.route("/chats/delete", methods=["POST"])
def delete_chat():
    global CURRENT_CHAT_ID
    chat_id = request.json.get("id")
    if chat_id in CHATS:
        del CHATS[chat_id]
        if CURRENT_CHAT_ID == chat_id:
            CURRENT_CHAT_ID = list(CHATS.keys())[0] if CHATS else None
            if not CURRENT_CHAT_ID:
                CURRENT_CHAT_ID = "default"
                CHATS["default"] = {"title": "Новый чат", "messages": []}
        return jsonify({"status": "ok"})
    return jsonify({"error": "Chat not found"}), 404


@app.route("/chats/rename", methods=["POST"])
def rename_chat():
    chat_id = request.json.get("id")
    new_title = request.json.get("title")
    if chat_id in CHATS and new_title:
        CHATS[chat_id]["title"] = new_title
        return jsonify({"status": "ok"})
    return jsonify({"error": "Chat not found"}), 404


@app.route("/chats/history", methods=["GET"])
def get_history():
    if CURRENT_CHAT_ID not in CHATS:
        return jsonify({"messages": []})

    msgs = []
    for m in CHATS[CURRENT_CHAT_ID]["messages"]:
        # m is a anti_client.Message object
        md = getattr(m, "model_dump", getattr(m, "dict", lambda: {}))()

        # Pydantic v1 vs v2 compatibility: some use 'model_dump', some 'dict'
        # Or we can just build it manually
        m_dict = {
            "role": m.role,
            "content": getattr(m, "_raw_content", m.content) if m.role == "user" else m.content,
        }
        if hasattr(m, "_attachments"):
            m_dict["attachments"] = m._attachments
        if m.tool_calls:
            m_dict["tool_calls"] = [
                {"id": tc.id, "name": tc.name, "arguments": tc.arguments}
                for tc in m.tool_calls
            ]
        if getattr(m, "tool_call_id", None):
            m_dict["tool_call_id"] = m.tool_call_id

        msgs.append(m_dict)

    return jsonify({"messages": msgs})


@app.route("/temp_image", methods=["GET"])
def temp_image():
    path = request.args.get("path", "")
    if not path.startswith(SHARED_TEMP_DIR) or not os.path.exists(path):
        return Response(status=404)
    with open(path, "rb") as f:
        data = f.read()
    return Response(data, mimetype="image/png")


@app.route("/export_paths", methods=["GET"])
def export_paths():
    token = uuid.uuid4().hex
    return jsonify(
        {
            "png_path": os.path.join(SHARED_TEMP_DIR, token + ".png"),
            "svg_path": os.path.join(SHARED_TEMP_DIR, token + ".svg"),
        }
    )


@app.route("/prepare_import", methods=["POST"])
def prepare_import():
    data = request.get_json(force=True)
    token = uuid.uuid4().hex
    path = os.path.join(SHARED_TEMP_DIR, token + "_import.svg")
    with open(path, "w", encoding="utf-8") as f:
        f.write(data.get("svg", ""))
    return jsonify({"path": path})


@app.route("/upload_attachment", methods=["POST"])
def upload_attachment():
    if "file" not in request.files:
        return jsonify({"error": "No file part"}), 400
    file = request.files["file"]
    if file.filename == "":
        return jsonify({"error": "No selected file"}), 400
    
    token = uuid.uuid4().hex
    ext = os.path.splitext(file.filename)[1]
    if not ext:
        ext = ".png"
    
    path = os.path.join(SHARED_TEMP_DIR, token + ext)
    file.save(path)
    
    return jsonify({
        "png_path": path,
        "name": file.filename or ("pasted_image" + ext)
    })


@app.route("/chat", methods=["POST"])
def chat():
    data = request.get_json(force=True)
    user_text = data.get("message", "")
    attachments = data.get("attachments", [])

    info = []
    if user_text:
        info.append(user_text)

    # Since anti_client Message only supports string content, we format everything as string.
    # Note: If anti_client updates to support images, we can change this format.
    for a in attachments:
        svg_path = a.get("svg_path")
        svg_text = ""
        if svg_path and os.path.exists(svg_path):
            with open(svg_path, "r", encoding="utf-8", errors="ignore") as f:
                svg_text = f.read()

        attachment_info = (
            "Прикреплённый объект ref={ref} name={name} properties={props}".format(
                ref=a.get("ref"),
                name=a.get("name"),
                props=json.dumps(a.get("properties", {}), ensure_ascii=False),
            )
        )
        if svg_text:
            attachment_info += "\nSVG контур (может быть обрезан):\n" + svg_text[:4000]

        info.append(attachment_info)

    final_text = "\n\n".join(info)
    if not final_text:
        final_text = "ping"
        
    import base64
    import mimetypes
    model_attachments = []
    for a in attachments:
        png_path = a.get("png_path")
        if png_path and os.path.exists(png_path):
            mime_type, _ = mimetypes.guess_type(png_path)
            if not mime_type:
                mime_type = "image/png"
            with open(png_path, "rb") as f:
                b64 = base64.b64encode(f.read()).decode("utf-8")
                model_attachments.append(FileAttachment(
                    mime_type=mime_type,
                    data=b64
                ))

    if CURRENT_CHAT_ID in CHATS:
        if len(CHATS[CURRENT_CHAT_ID]["messages"]) == 0:
            CHATS[CURRENT_CHAT_ID]["title"] = user_text[:30] + (
                "..." if len(user_text) > 30 else ""
            )
        msg = Message(role="user", content=final_text, attachments=model_attachments)
        msg._raw_content = user_text
        msg._attachments = attachments
        CHATS[CURRENT_CHAT_ID]["messages"].append(msg)

    resp = Response(
        stream_with_context(stream_agent_loop()),
        mimetype="text/event-stream",
        direct_passthrough=True,
    )
    resp.headers["X-Content-Type-Options"] = "nosniff"
    resp.headers["Cache-Control"] = "no-cache"
    return resp


@app.route("/tool_result", methods=["POST"])
def tool_result():
    data = request.get_json(force=True)
    result = data.get("result", {})

    svg_path = result.get("svg_path")
    if svg_path and os.path.exists(svg_path):
        with open(svg_path, "r", encoding="utf-8", errors="ignore") as f:
            result = dict(result)
            result["svg"] = f.read()[:6000]

    if CURRENT_CHAT_ID in CHATS:
        CHATS[CURRENT_CHAT_ID]["messages"].append(
            Message(
                role="tool",
                tool_call_id=data["tool_call_id"],
                content=json.dumps(result, ensure_ascii=False),
            )
        )

    resp = Response(
        stream_with_context(stream_agent_loop()),
        mimetype="text/event-stream",
        direct_passthrough=True,
    )
    resp.headers["X-Content-Type-Options"] = "nosniff"
    resp.headers["Cache-Control"] = "no-cache"
    return resp


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5055, threaded=True)

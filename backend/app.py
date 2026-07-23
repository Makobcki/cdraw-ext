import asyncio
import base64
import json
import mimetypes
import os
import sys
import threading
import uuid

from anti_client import Client, FileAttachment, Message
from flask import (
    Flask,
    Response,
    jsonify,
    request,
    send_from_directory,
    stream_with_context,
)

import updater
from auth_manager import (
    get_current_client,
    load_accounts,
    load_oauth_config,
    save_accounts,
    save_oauth_config,
)
from chat_manager import (
    load_chats,
    save_chats,
    serialize_message,
)
from config import (
    AI_MODEL,
    BROWSER_EMULATION_VERSION,
    CHATS_FILE,
    HIDDEN_MODELS_FILE,
    MAX_SVG_CHAR_LIMIT,
    MODEL_BLACKLIST_KEYWORDS,
    MULTI_ACCOUNTS_FILE,
    OAUTH_CONFIG_FILE,
    SERVER_HOST,
    SERVER_PORT,
    SHARED_TEMP_DIR,
    STATIC_DIR,
    SYSTEM_PROMPT,
    atomic_write_json,
    is_blacklisted_model,
    read_json_locked,
)
from tools import TOOLS


def fix_browser_emulation():
    if sys.platform != "win32":
        return
    try:
        import winreg

        key_path = r"Software\Microsoft\Internet Explorer\Main\FeatureControl\FEATURE_BROWSER_EMULATION"
        with winreg.CreateKey(winreg.HKEY_CURRENT_USER, key_path) as key:
            winreg.SetValueEx(
                key, "CorelDRW.exe", 0, winreg.REG_DWORD, BROWSER_EMULATION_VERSION
            )
    except Exception as e:
        print("Registry fix error:", e)


fix_browser_emulation()

app = Flask(__name__, static_folder=None)

client = get_current_client()
CHATS, CURRENT_CHAT_ID = load_chats()
_cached_models = None


def persist_chats():
    save_chats(CHATS, CURRENT_CHAT_ID)


def load_hidden_models():
    data = read_json_locked(HIDDEN_MODELS_FILE, default_factory=list)
    if isinstance(data, list):
        return set(data)
    return set()


def save_hidden_models(hidden_set):
    atomic_write_json(HIDDEN_MODELS_FILE, list(hidden_set))


def get_all_models(bypass_cache=False):
    global _cached_models
    if not bypass_cache and _cached_models is not None:
        return _cached_models
    try:
        c = Client()
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        try:
            models = loop.run_until_complete(c.models.list())
        finally:
            loop.close()

        seen_api_names = set()
        parsed = []
        for m in models:
            raw_id = str(m.id).strip()
            if not raw_id:
                continue
            # Compare strictly by API model name for deduplication
            normalized_api_name = raw_id.lower().replace("models/", "")
            if normalized_api_name in seen_api_names:
                continue

            dname = (
                str(m.display_name).strip()
                if getattr(m, "display_name", None)
                else raw_id
            )
            if is_blacklisted_model(raw_id, dname):
                continue

            seen_api_names.add(normalized_api_name)

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
                    "id": raw_id,
                    "display_name": dname,
                    "quota_pct": quota_pct,
                }
            )

        parsed.sort(key=lambda x: x["display_name"].lower())
        _cached_models = parsed
        return _cached_models
    except Exception as e:
        print("Error fetching models:", e)
        return [
            {"id": AI_MODEL, "display_name": "Gemini 3.1 Pro (low)", "quota_pct": None}
        ]


def stream_agent_loop(chat_id):
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

    chat_messages = CHATS.get(chat_id, {}).get("messages", [])
    messages = [Message(role="system", content=SYSTEM_PROMPT)] + chat_messages

    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)

    async def get_stream():
        return await client.generate(
            model=AI_MODEL, messages=messages, tools=TOOLS, stream=True
        )

    try:
        try:
            gen = loop.run_until_complete(get_stream())
        except Exception as e:
            yield (
                json.dumps({"type": "error", "error": str(e)}, ensure_ascii=False)
                + "\n"
            ).encode("utf-8")
            return

        full_text = ""
        full_thought = ""
        has_tools = False

        while True:
            try:
                chunk = loop.run_until_complete(gen.__anext__())

                chunk_text = getattr(chunk, "text", None)
                chunk_thought = getattr(chunk, "thought", None)
                chunk_tool_calls = getattr(chunk, "tool_calls", None)

                if isinstance(chunk, str):
                    chunk_text = chunk
                elif isinstance(chunk, list):
                    chunk_tool_calls = chunk

                if chunk_thought:
                    full_thought += chunk_thought
                    yield (
                        json.dumps(
                            {"type": "thought", "text": chunk_thought},
                            ensure_ascii=False,
                        )
                        + "\n"
                    ).encode("utf-8")

                if chunk_text:
                    full_text += chunk_text
                    yield (
                        json.dumps(
                            {"type": "chunk", "text": chunk_text}, ensure_ascii=False
                        )
                        + "\n"
                    ).encode("utf-8")

                if chunk_tool_calls:
                    has_tools = True
                    calls = [
                        {"id": tc.id, "name": tc.name, "arguments": tc.arguments}
                        for tc in chunk_tool_calls
                    ]
                    if chat_id in CHATS:
                        content_val = (
                            full_text if (full_text and full_text.strip()) else None
                        )
                        thought_val = (
                            full_thought
                            if (full_thought and full_thought.strip())
                            else None
                        )
                        CHATS[chat_id]["messages"].append(
                            Message(
                                role="assistant",
                                content=content_val,
                                thought=thought_val,
                                tool_calls=chunk_tool_calls,
                            )
                        )
                        persist_chats()
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

        if not has_tools and (
            (full_text and full_text.strip()) or (full_thought and full_thought.strip())
        ):
            if chat_id in CHATS:
                CHATS[chat_id]["messages"].append(
                    Message(
                        role="assistant",
                        content=full_text if full_text and full_text.strip() else None,
                        thought=full_thought
                        if full_thought and full_thought.strip()
                        else None,
                    )
                )
                persist_chats()

        yield (json.dumps({"type": "done"}, ensure_ascii=False) + "\n").encode("utf-8")
    finally:
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


@app.route("/favicon.ico", methods=["GET"])
def favicon():
    return ("", 204)


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


update_lock = threading.Lock()


@app.route("/updater/apply", methods=["POST"])
def updater_apply():
    if not update_lock.acquire(blocking=False):
        return jsonify(
            {"status": "error", "message": "Обновление уже выполняется"}
        ), 423
    try:
        data = request.get_json(silent=True) or {}
        target_version = data.get("target_version")
        source_path = data.get("source_path")
        do_restart = data.get("restart", True)
        res = updater.apply_update(
            source_path=source_path, target_version=target_version
        )
        if res.get("status") == "success" and do_restart:
            updater.schedule_restart(delay=1.0)
        return jsonify(res)
    finally:
        update_lock.release()


@app.route("/updater/rollback", methods=["POST"])
def updater_rollback():
    if not update_lock.acquire(blocking=False):
        return jsonify({"status": "error", "message": "Операция уже выполняется"}), 423
    try:
        data = request.get_json(silent=True) or {}
        do_restart = data.get("restart", True)
        res = updater.rollback_update()
        if res.get("status") == "success" and do_restart:
            updater.schedule_restart(delay=1.0)
        return jsonify(res)
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 400
    finally:
        update_lock.release()


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

            if (
                AI_MODEL == model_to_hide
                or AI_MODEL in hidden
                or not any(m["id"] == AI_MODEL for m in visible_models)
            ):
                if visible_models:
                    AI_MODEL = visible_models[0]["id"]

            return jsonify(
                {
                    "status": "ok",
                    "current_model": AI_MODEL,
                    "available_models": visible_models,
                }
            )
        return jsonify({"error": "Invalid model"}), 400


@app.route("/settings/model/reset", methods=["POST"])
def reset_models():
    global _cached_models, AI_MODEL
    if os.path.exists(HIDDEN_MODELS_FILE):
        try:
            os.remove(HIDDEN_MODELS_FILE)
        except Exception:
            pass
    _cached_models = None
    all_models = get_all_models(bypass_cache=True)
    if all_models and not any(m["id"] == AI_MODEL for m in all_models):
        AI_MODEL = all_models[0]["id"]
    return jsonify(
        {"status": "ok", "current_model": AI_MODEL, "available_models": all_models}
    )


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
    def do_login():
        import subprocess
        import sys

        try:
            subprocess.run(
                [
                    sys.executable,
                    "-c",
                    "import anti_client.client; anti_client.client.authenticate()",
                ],
                check=True,
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
    persist_chats()
    return jsonify({"id": new_id})


@app.route("/chats/switch", methods=["POST"])
def switch_chat():
    global CURRENT_CHAT_ID
    chat_id = request.json.get("id")
    if chat_id in CHATS:
        CURRENT_CHAT_ID = chat_id
        persist_chats()
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
        persist_chats()
        return jsonify({"status": "ok"})
    return jsonify({"error": "Chat not found"}), 404


@app.route("/chats/rename", methods=["POST"])
def rename_chat():
    chat_id = request.json.get("id")
    new_title = request.json.get("title")
    if chat_id in CHATS and new_title:
        CHATS[chat_id]["title"] = new_title
        persist_chats()
        return jsonify({"status": "ok"})
    return jsonify({"error": "Chat not found"}), 404


@app.route("/chats/history", methods=["GET"])
def get_history():
    if CURRENT_CHAT_ID not in CHATS:
        return jsonify({"messages": []})

    msgs = []
    for m in CHATS[CURRENT_CHAT_ID]["messages"]:
        s_msg = serialize_message(m)
        content = s_msg.get("content")
        thought = s_msg.get("thought")
        has_content = bool(
            content and isinstance(content, str) and content.strip() != ""
        )
        has_thought = bool(
            thought and isinstance(thought, str) and thought.strip() != ""
        )
        has_tool_calls = bool(s_msg.get("tool_calls"))
        has_attachments = bool(s_msg.get("attachments") or s_msg.get("_attachments"))
        has_tool_id = bool(s_msg.get("tool_call_id"))

        if (
            not has_content
            and not has_thought
            and not has_tool_calls
            and not has_attachments
            and not has_tool_id
        ):
            continue
        msgs.append(s_msg)

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

    return jsonify({"png_path": path, "name": file.filename or ("pasted_image" + ext)})


@app.route("/chat", methods=["POST"])
def chat():
    data = request.get_json(force=True)
    user_text = data.get("message", "")
    attachments = data.get("attachments", [])
    chat_id = data.get("chat_id") or CURRENT_CHAT_ID

    info = []
    if user_text and user_text.strip():
        info.append(user_text)

    for a in attachments:
        svg_path = a.get("svg_path")
        svg_text = ""
        if svg_path and os.path.exists(svg_path):
            with open(svg_path, "r", encoding="utf-8", errors="ignore") as f:
                svg_text = f.read()

        display_name = (
            a.get("display_name") or a.get("properties", {}).get("typeName") or "Object"
        )
        attachment_info = "Прикреплённый объект {display_name} ref={ref} name={name} properties={props}".format(
            display_name=display_name,
            ref=a.get("ref"),
            name=a.get("name"),
            props=json.dumps(a.get("properties", {}), ensure_ascii=False),
        )
        if svg_text:
            attachment_info += "\nSVG контур (может быть обрезан):\n" + svg_text[:4000]

        info.append(attachment_info)

    final_text = "\n\n".join(info)
    if not final_text and not attachments:
        return jsonify(
            {"status": "error", "message": "Сообщение не может быть пустым"}
        ), 400
    if not final_text:
        final_text = "ping"

    model_attachments = []
    for a in attachments:
        png_path = a.get("png_path")
        if png_path and os.path.exists(png_path):
            mime_type, _ = mimetypes.guess_type(png_path)
            if not mime_type:
                mime_type = "image/png"
            with open(png_path, "rb") as f:
                b64 = base64.b64encode(f.read()).decode("utf-8")
                model_attachments.append(FileAttachment(mime_type=mime_type, data=b64))

    if chat_id in CHATS:
        if len(CHATS[chat_id]["messages"]) == 0:
            CHATS[chat_id]["title"] = user_text[:30] + (
                "..." if len(user_text) > 30 else ""
            )
        msg = Message(role="user", content=final_text, attachments=model_attachments)
        msg._raw_content = user_text
        msg._attachments = attachments
        CHATS[chat_id]["messages"].append(msg)
        persist_chats()

    resp = Response(
        stream_with_context(stream_agent_loop(chat_id)),
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
    chat_id = data.get("chat_id") or CURRENT_CHAT_ID

    svg_path = result.get("svg_path")
    if svg_path and os.path.exists(svg_path):
        with open(svg_path, "r", encoding="utf-8", errors="ignore") as f:
            result = dict(result)
            result["svg"] = f.read()[:MAX_SVG_CHAR_LIMIT]

    model_attachments = []
    png_path = result.get("png_path")
    if png_path and os.path.exists(png_path):
        mime_type, _ = mimetypes.guess_type(png_path)
        if not mime_type:
            mime_type = "image/png"
        with open(png_path, "rb") as f:
            b64 = base64.b64encode(f.read()).decode("utf-8")
            model_attachments.append(FileAttachment(mime_type=mime_type, data=b64))

    if chat_id in CHATS:
        CHATS[chat_id]["messages"].append(
            Message(
                role="tool",
                tool_call_id=data["tool_call_id"],
                content=json.dumps(result, ensure_ascii=False),
                attachments=model_attachments,
            )
        )
        persist_chats()

    resp = Response(
        stream_with_context(stream_agent_loop(chat_id)),
        mimetype="text/event-stream",
        direct_passthrough=True,
    )
    resp.headers["X-Content-Type-Options"] = "nosniff"
    resp.headers["Cache-Control"] = "no-cache"
    return resp


if __name__ == "__main__":
    app.run(host=SERVER_HOST, port=SERVER_PORT, threaded=True)

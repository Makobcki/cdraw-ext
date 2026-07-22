import os
from anti_client import Message, ToolCall, FileAttachment
from config import CHATS_FILE, atomic_write_json, read_json_locked


def serialize_message(m):
    m_dict = {
        "role": m.role,
        "content": getattr(m, "_raw_content", m.content) if m.role == "user" else m.content,
    }
    if getattr(m, "_raw_content", None) is not None:
        m_dict["_raw_content"] = m._raw_content
    if getattr(m, "_attachments", None) is not None:
        m_dict["_attachments"] = m._attachments
    if getattr(m, "tool_call_id", None):
        m_dict["tool_call_id"] = m.tool_call_id
    if m.tool_calls:
        m_dict["tool_calls"] = [
            {
                "id": tc.id,
                "name": tc.name,
                "arguments": tc.arguments,
                "thought_signature": getattr(tc, "thought_signature", None),
            }
            for tc in m.tool_calls
        ]
    if m.attachments:
        m_dict["attachments"] = [
            {"mime_type": fa.mime_type, "data": fa.data}
            for fa in m.attachments
        ]
    return m_dict


def deserialize_message(m_dict):
    tool_calls = None
    if m_dict.get("tool_calls"):
        tool_calls = [
            ToolCall(
                id=tc["id"],
                name=tc["name"],
                arguments=tc.get("arguments", {}),
                thought_signature=tc.get("thought_signature"),
            )
            for tc in m_dict["tool_calls"]
        ]
    attachments = None
    if m_dict.get("attachments"):
        attachments = [
            FileAttachment(
                mime_type=fa["mime_type"],
                data=fa["data"],
            )
            for fa in m_dict["attachments"]
        ]
    msg = Message(
        role=m_dict["role"],
        content=m_dict.get("content"),
        tool_calls=tool_calls,
        tool_call_id=m_dict.get("tool_call_id"),
        attachments=attachments,
    )
    if "_raw_content" in m_dict:
        msg._raw_content = m_dict["_raw_content"]
    if "_attachments" in m_dict:
        msg._attachments = m_dict["_attachments"]
    return msg


def load_chats():
    data = read_json_locked(CHATS_FILE, default_factory=dict)
    chats = {}
    for cid, cdata in data.get("chats", {}).items():
        messages = [
            deserialize_message(m) for m in cdata.get("messages", [])
        ]
        chats[cid] = {
            "title": cdata.get("title", "Новый чат"),
            "messages": messages,
        }
    current_id = data.get("current_id", "default")
    if not chats:
        chats = {"default": {"title": "Новый чат", "messages": []}}
        current_id = "default"
    elif current_id not in chats:
        current_id = list(chats.keys())[0]
    return chats, current_id


def save_chats(chats, current_chat_id):
    data = {
        "current_id": current_chat_id,
        "chats": {},
    }
    for cid, cdata in chats.items():
        serialized_msgs = [
            serialize_message(m) for m in cdata.get("messages", [])
        ]
        data["chats"][cid] = {
            "title": cdata.get("title", "Новый чат"),
            "messages": serialized_msgs,
        }
    atomic_write_json(CHATS_FILE, data)

import json
import os
from anti_client import Tool

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
TOOLS_FILE = os.path.join(BASE_DIR, "tools.json")


def load_tools():
    tools_list = []
    if os.path.exists(TOOLS_FILE):
        try:
            with open(TOOLS_FILE, "r", encoding="utf-8") as f:
                raw_tools = json.load(f)
                if isinstance(raw_tools, list):
                    for item in raw_tools:
                        tools_list.append(
                            Tool(
                                name=item.get("name"),
                                description=item.get("description", ""),
                                parameters=item.get("parameters", {}),
                            )
                        )
        except Exception as e:
            print(f"Error loading {TOOLS_FILE}:", e)
    return tools_list


TOOLS = load_tools()

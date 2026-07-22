import requests
import json
import time
import subprocess
import os

env = os.environ.copy()
env["FLASK_APP"] = "app.py"

proc = subprocess.Popen(["/home/frosty/cdraw-ext/backend/.venv/bin/python", "-m", "flask", "run", "--port", "5001", "--host", "127.0.0.1"], cwd="/home/frosty/cdraw-ext/backend", env=env)
time.sleep(3)

try:
    # Send a chat with attachments
    payload = {
        "message": "Hello",
        "attachments": [
            {"png_path": "/tmp/test.png", "name": "test.png", "properties": {}}
        ]
    }
    r = requests.post("http://127.0.0.1:5001/chat", json=payload, stream=True)
    for line in r.iter_lines():
        if line:
            pass

    r = requests.get("http://127.0.0.1:5001/chats/history")
    print("HISTORY:")
    print(json.dumps(r.json(), indent=2, ensure_ascii=False))
finally:
    proc.terminate()

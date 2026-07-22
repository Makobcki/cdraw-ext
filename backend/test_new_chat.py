import requests
import os
import subprocess
import time

env = os.environ.copy()
env["FLASK_APP"] = "app.py"

proc = subprocess.Popen(["/home/frosty/cdraw-ext/backend/.venv/bin/python", "-m", "flask", "run", "--port", "5003", "--host", "127.0.0.1"], cwd="/home/frosty/cdraw-ext/backend", env=env)
time.sleep(2)

try:
    r = requests.post("http://127.0.0.1:5003/chats/new", json={})
    print("/chats/new:", r.status_code, r.text)

    r2 = requests.get("http://127.0.0.1:5003/chats")
    print("/chats:", r2.status_code, r2.text)
finally:
    proc.terminate()

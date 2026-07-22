import requests
import json

# Send a chat with attachments
payload = {
    "message": "Hello",
    "attachments": [
        {"png_path": "/home/frosty/cdraw-ext/backend/test.png", "name": "test.png"}
    ]
}

# we need to make sure the server is running. I will run the server in background.

import base64
import json
import os
import random
import uuid
import time
from flask import Flask, jsonify, request, send_from_directory, Response, stream_with_context

STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")
app = Flask(__name__, static_folder=None)

@app.route("/")
def index():
    return send_from_directory(STATIC_DIR, "index.html")

@app.route("/static/<path:filename>")
def static_files(filename):
    return send_from_directory(STATIC_DIR, filename)

def generate_random_stream():
    # Эмуляция "размышлений"
    time.sleep(1.0)
    
    # 50% вероятность ответить текстом, 50% - вызвать функцию
    if random.random() < 0.5:
        # Генерируем случайный текст и отдаем по частям
        phrases = ["Это ", "рандомный ", "текст ", "для ", "тестирования ", "интерфейса.\n", "Функции ", "работают ", "отлично! ", "Проверка ", "анимации ", "печати."]
        random.shuffle(phrases)
        for p in phrases:
            yield (json.dumps({"type": "chunk", "text": p}, ensure_ascii=False) + "\n").encode("utf-8")
            time.sleep(0.3)
    else:
        # Сначала немножко текста ("размышления" до вызова)
        yield (json.dumps({"type": "chunk", "text": "Сейчас я вызову функцию...\n"}, ensure_ascii=False) + "\n").encode("utf-8")
        time.sleep(1.0)
        
        tools = [
            ("set_fill_color", {"ref": "shape_" + str(random.randint(100, 999)), "hex_color": f"#{random.randint(0, 0xFFFFFF):06x}"}),
            ("rotate", {"ref": "shape_" + str(random.randint(100, 999)), "angle": random.randint(1, 360)}),
            ("set_position", {"ref": "shape_" + str(random.randint(100, 999)), "x": random.randint(0, 100), "y": random.randint(0, 100)}),
            ("set_size", {"ref": "shape_" + str(random.randint(100, 999)), "width": random.randint(10, 200), "height": random.randint(10, 200)}),
            ("duplicate", {"ref": "shape_" + str(random.randint(100, 999))})
        ]
        chosen_tool, args = random.choice(tools)
        
        calls = [{"id": "call_" + uuid.uuid4().hex[:8], "name": chosen_tool, "arguments": args}]
        yield (json.dumps({"type": "tool_calls", "calls": calls}, ensure_ascii=False) + "\n").encode("utf-8")
    
    yield (json.dumps({"type": "done"}, ensure_ascii=False) + "\n").encode("utf-8")


@app.route("/chat", methods=["POST"])
def chat():
    return Response(stream_with_context(generate_random_stream()), mimetype='application/json')

@app.route("/tool_result", methods=["POST"])
def tool_result():
    def respond_after_tool():
        time.sleep(1.0)
        if random.random() < 0.6:
            text = "Я обработал результат функции. Всё прошло успешно!"
            # Стримим результат
            for word in text.split(' '):
                yield (json.dumps({"type": "chunk", "text": word + ' '}, ensure_ascii=False) + "\n").encode("utf-8")
                time.sleep(0.2)
            yield (json.dumps({"type": "done"}, ensure_ascii=False) + "\n").encode("utf-8")
        else:
            yield from generate_random_stream()
            
    return Response(stream_with_context(respond_after_tool()), mimetype='application/json')

if __name__ == "__main__":
    print("Запускаю моковый API-сервер на порту 5056...")
    app.run(host="127.0.0.1", port=5056, threaded=True)

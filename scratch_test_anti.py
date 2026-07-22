import asyncio
from anti_client import Client, Message

async def main():
    client = Client()
    messages = [Message(role="user", content="Hello, count to 10 slowly.")]
    gen = await client.generate(model="gemini-2.5-pro", messages=messages, stream=True)
    try:
        while True:
            chunk = await gen.__anext__()
            print("CHUNK:", repr(chunk))
    except StopAsyncIteration:
        pass

asyncio.run(main())

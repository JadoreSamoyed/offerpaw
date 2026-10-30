"""Exercise the real HTTP/WebSocket readiness hook without loading ASR models."""
import asyncio
import json
import unittest
from functools import partial

from websockets.asyncio.client import connect
from websockets.asyncio.server import serve

from health import readiness_response


class ReadinessTests(unittest.IsolatedAsyncioTestCase):
    async def test_health_does_not_consume_session_and_websocket_remains_usable(self):
        sessions = []

        async def handler(socket):
            sessions.append(True)
            await socket.send("existing websocket route")

        async with serve(handler, "127.0.0.1", 0, process_request=partial(
                readiness_response, model="test-model", speaker_supported=True)) as server:
            port = server.sockets[0].getsockname()[1]
            reader, writer = await asyncio.open_connection("127.0.0.1", port)
            writer.write(b"GET /health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
            await writer.drain()
            response = await asyncio.wait_for(reader.read(), 3)
            writer.close()
            await writer.wait_closed()
            header, body = response.split(b"\r\n\r\n", 1)
            self.assertIn(b"200 OK", header)
            self.assertEqual(header.count(b"Content-Type:"), 1)
            self.assertIn(b"Content-Type: application/json", header)
            self.assertEqual(json.loads(body), {
                "status": "ready", "model": "test-model", "speakerSupported": True,
            })
            self.assertEqual(sessions, [])
            async with connect(f"ws://127.0.0.1:{port}", proxy=None) as socket:
                self.assertEqual(await socket.recv(), "existing websocket route")
            self.assertEqual(len(sessions), 1)

    def test_non_health_request_is_left_to_websocket_and_missing_speaker_is_explicit(self):
        from types import SimpleNamespace
        from websockets.datastructures import Headers

        class Connection:
            def respond(self, status, text):
                return SimpleNamespace(status_code=status, body=text,
                                       headers=Headers({"Content-Type": "text/plain"}))

        self.assertIsNone(readiness_response(Connection(), SimpleNamespace(path="/"), "test", True))
        response = readiness_response(Connection(), SimpleNamespace(path="/health"), "test", False)
        self.assertFalse(json.loads(response.body)["speakerSupported"])


if __name__ == "__main__":
    unittest.main()

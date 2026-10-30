"""Readiness response without occupying a recognition session or loading a model."""
from http import HTTPStatus
import json


def readiness_response(connection, request, model, speaker_supported):
    if request.path != "/health":
        return None
    response = connection.respond(HTTPStatus.OK, json.dumps({
        "status": "ready", "model": model, "speakerSupported": speaker_supported,
    }) + "\n")
    if "Content-Type" in response.headers:
        del response.headers["Content-Type"]
    response.headers["Content-Type"] = "application/json"
    response.headers["Cache-Control"] = "no-store"
    return response

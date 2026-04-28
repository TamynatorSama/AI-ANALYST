



@tool("dataan_websocket_bridge")
def dataan_websocket_bridge(message: str,wait: bool) -> str:
    """
    This is a tool to bridge to the DataAn websocket endpoint., it uses web sockets to send message to the user (Human in the loop) and get response back if wait is set to True.
    Args:
        message (str): The message to send to the DataAn websocket endpoint.
        wait (bool): Whether to wait for a response from the user.
    Returns:
        str: The response from the DataAn websocket endpoint if wait is True, otherwise an empty string.
    """

    if not message.strip():
        return "No message provided for websocket bridge."

    if connect is None:
        return "websockets.sync.client is unavailable in this environment."

    client_ref = str(uuid4())
    payload = json.dumps(
        {
            "role": "agent",
            "content": message,
            "client_ref": client_ref,
            "client_id": "dataan-tool",
        }
    )

    try:
        with connect(WEBSOCKET_URL) as websocket:
            websocket.send(payload)
            attempts = 0
            while attempts < 25:
                attempts += 1
                raw = websocket.recv()
                try:
                    response = json.loads(raw)
                except json.JSONDecodeError:
                    return raw

                msg_type = response.get("type")
                if msg_type == "system":
                    continue

                if response.get("client_ref") == client_ref and response.get("role") == "agent":
                    continue

                content = response.get("content") or ""
                if not content:
                    continue
                return content
            return "No response received before timeout."
    except Exception as exc:  # pragma: no cover - network path
        return f"Failed to use websocket: {exc}"
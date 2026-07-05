"""notify.py 測試：ntfy 通道、多通道推播與降級。"""

from sunset.notify import NtfyChannel, any_configured, send_push


class _FakeResponse:
    def raise_for_status(self):
        pass


class _FakeSession:
    def __init__(self, fail: bool = False):
        self.fail = fail
        self.calls = []

    def post(self, url, data=None, timeout=None, json=None):
        self.calls.append({"url": url, "data": data, "timeout": timeout})
        if self.fail:
            raise ConnectionError("down")
        return _FakeResponse()


def test_ntfy_send():
    session = _FakeSession()
    ch = NtfyChannel(topic="my-secret-topic", session=session)
    assert ch.configured
    assert ch.send("測試訊息")
    call = session.calls[0]
    assert call["url"] == "https://ntfy.sh/my-secret-topic"
    assert call["data"] == "測試訊息".encode()
    assert call["timeout"] is not None


def test_ntfy_custom_server():
    session = _FakeSession()
    ch = NtfyChannel(topic="t", server="https://ntfy.example.com/", session=session)
    ch.send("hi")
    assert session.calls[0]["url"] == "https://ntfy.example.com/t"


def test_ntfy_failure_degrades():
    """失敗重試一次後回傳 False，不拋例外。"""
    session = _FakeSession(fail=True)
    ch = NtfyChannel(topic="t", session=session)
    assert not ch.send("hi")
    assert len(session.calls) == 2  # 原始 + 重試


def test_ntfy_unconfigured():
    ch = NtfyChannel(topic="")
    assert not ch.configured


class _StubChannel:
    def __init__(self, name: str, configured: bool, ok: bool):
        self.name = name
        self._configured = configured
        self._ok = ok
        self.sent = []

    @property
    def configured(self) -> bool:
        return self._configured

    def send(self, text: str) -> bool:
        self.sent.append(text)
        return self._ok


def test_send_push_multi_channel():
    tg = _StubChannel("telegram", configured=True, ok=True)
    nt = _StubChannel("ntfy", configured=True, ok=False)
    off = _StubChannel("off", configured=False, ok=True)
    assert send_push("msg", channels=[tg, nt, off]) == ["telegram"]
    assert tg.sent == ["msg"]
    assert nt.sent == ["msg"]
    assert off.sent == []  # 未設定的通道不呼叫


def test_any_configured():
    assert not any_configured(channels=[_StubChannel("a", False, True)])
    assert any_configured(channels=[_StubChannel("a", True, True)])

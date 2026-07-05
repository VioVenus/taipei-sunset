"""統一推播層：同一則訊息可同時走多個通道。

通道：
- telegram：既有 TelegramClient（需申請 bot + chat id）。
- ntfy：手機裝 ntfy app 訂閱一個私密主題即可收推播，免申請、免金鑰，
  發送端只是對 https://ntfy.sh/<topic> 做 HTTP POST。設定環境變數
  NTFY_TOPIC（建議用長隨機字串當主題名）即啟用；NTFY_SERVER 可自架覆蓋。

任一通道失敗都不拋例外（降級原則同 weather）。
"""

from __future__ import annotations

import os
from typing import Any, Protocol

import requests

from sunset.telegram_io import TelegramClient

NTFY_DEFAULT_SERVER = "https://ntfy.sh"
REQUEST_TIMEOUT_SEC = 10.0
RETRY_COUNT = 1


class PushChannel(Protocol):
    """推播通道共同介面。"""

    name: str

    @property
    def configured(self) -> bool: ...

    def send(self, text: str) -> bool: ...


class TelegramChannel:
    """Telegram 通道（包 TelegramClient）。"""

    name = "telegram"

    def __init__(self, client: TelegramClient | None = None) -> None:
        self._client = client or TelegramClient()

    @property
    def configured(self) -> bool:
        return self._client.configured

    def send(self, text: str) -> bool:
        return self._client.send_message(text)


class NtfyChannel:
    """ntfy 通道：POST 純文字到 <server>/<topic>。"""

    name = "ntfy"

    def __init__(
        self,
        topic: str | None = None,
        server: str | None = None,
        session: Any | None = None,
    ) -> None:
        self.topic = topic or os.environ.get("NTFY_TOPIC", "")
        self.server = (server or os.environ.get("NTFY_SERVER", NTFY_DEFAULT_SERVER)).rstrip("/")
        self._session = session if session is not None else requests

    @property
    def configured(self) -> bool:
        return bool(self.topic)

    def send(self, text: str) -> bool:
        url = f"{self.server}/{self.topic}"
        for _attempt in range(RETRY_COUNT + 1):
            try:
                resp = self._session.post(
                    url, data=text.encode("utf-8"), timeout=REQUEST_TIMEOUT_SEC
                )
                resp.raise_for_status()
                return True
            except Exception:  # noqa: BLE001 - 降級路徑
                continue
        return False


def default_channels() -> list[PushChannel]:
    return [TelegramChannel(), NtfyChannel()]


def send_push(text: str, channels: list[PushChannel] | None = None) -> list[str]:
    """對所有已設定的通道推播，回傳成功的通道名稱列表。"""
    chans = channels if channels is not None else default_channels()
    return [ch.name for ch in chans if ch.configured and ch.send(text)]


def any_configured(channels: list[PushChannel] | None = None) -> bool:
    chans = channels if channels is not None else default_channels()
    return any(ch.configured for ch in chans)

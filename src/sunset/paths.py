"""資料目錄解析：editable 安裝取 repo 根目錄，一般安裝退回工作目錄。

`pip install .`（非 editable；Actions 排程 workflow 即此情況）會把套件
複製進 site-packages，`__file__` 的相對路徑不再指向 repo，
`data/viewpoints.json` 會 FileNotFoundError、日誌會寫進 site-packages
然後被 `git add data/logs` 漏掉。所有 workflow 都在 repo 根目錄執行，
因此退回以 CWD 為準。
"""

from __future__ import annotations

from pathlib import Path

_PACKAGE_DATA = Path(__file__).resolve().parents[2] / "data"


def data_dir(package_candidate: Path | None = None) -> Path:
    candidate = _PACKAGE_DATA if package_candidate is None else package_candidate
    if candidate.is_dir():
        return candidate
    return Path.cwd() / "data"

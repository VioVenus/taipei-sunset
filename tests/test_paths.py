"""回歸測試：資料目錄解析（daily-forecast run #1 線上事故）。

非 editable 安裝（pip install .）時 __file__ 相對路徑指向 site-packages，
data/viewpoints.json 找不到、日誌寫錯位置。修正後必須退回 CWD。
"""

from __future__ import annotations

from pathlib import Path

from sunset.paths import data_dir


def test_editable_install_prefers_repo_data_dir():
    repo_data = Path(__file__).resolve().parents[1] / "data"
    assert data_dir() == repo_data


def test_site_packages_install_falls_back_to_cwd(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    missing = tmp_path / "site-packages-like" / "data"  # 不存在
    assert data_dir(package_candidate=missing) == tmp_path / "data"


def test_explicit_existing_candidate_wins_over_cwd(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    candidate = tmp_path / "elsewhere" / "data"
    candidate.mkdir(parents=True)
    assert data_dir(package_candidate=candidate) == candidate

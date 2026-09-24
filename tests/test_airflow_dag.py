"""Airflow DAG 結構測試。

Airflow 不是本專案的執行期相依（GitHub Actions 版不需要它），所以沒安裝時
整檔跳過，CI 不受影響。要跑這些測試見 airflow/README.md。

測的是「排程契約」而不是業務邏輯：schedule／時區／catchup／max_active_runs／
retries 這幾項都是刻意選的，改動它們會改變管線的正確性（例如 catchup 打開
會用今天的預報去填過去的日期），所以用測試釘住。
"""

import os
from pathlib import Path

import pytest

pytest.importorskip("airflow.models", reason="需要 apache-airflow，見 airflow/README.md")

DAG_DIR = Path(__file__).resolve().parents[1] / "airflow" / "dags"
os.environ.setdefault("AIRFLOW_HOME", str(Path(__file__).resolve().parents[1] / ".airflow_home"))


@pytest.fixture(scope="module")
def dagbag():
    from airflow.models import DagBag

    return DagBag(dag_folder=str(DAG_DIR), include_examples=False)


def test_dags_import_without_error(dagbag):
    assert dagbag.import_errors == {}, f"DAG 匯入失敗：{dagbag.import_errors}"
    assert "sunset_daily" in dagbag.dags


def test_schedule_is_taipei_local_time(dagbag):
    """16:20 台北。宣告時區而非手算 UTC，才不會每年日光節約時間偏一小時。"""
    dag = dagbag.dags["sunset_daily"]
    assert str(dag.timezone) == "Asia/Taipei"
    assert dag.timetable.summary == "20 16 * * *"


def test_catchup_disabled(dagbag):
    """天氣 API 只供應未來預報，補跑會把今天的預報寫進過去的日期。"""
    assert dagbag.dags["sunset_daily"].catchup is False


def test_single_active_run(dagbag):
    """predictions.csv 是 append-only，並行寫入會交錯。"""
    assert dagbag.dags["sunset_daily"].max_active_runs == 1


def test_logbook_never_retries(dagbag):
    """append-only 寫入重試會製造重複列，寧可紅掉讓人看一眼。"""
    tasks = {t.task_id: t for t in dagbag.dags["sunset_daily"].tasks}
    assert tasks["write_logbook"].retries == 0
    assert tasks["fetch_and_score"].retries > 0, "網路 I/O 應該要能重試"
    assert tasks["broadcast"].retries > 0, "推播重試最壞是推兩次，可接受"


def test_logbook_and_broadcast_are_independent(dagbag):
    """日誌與推播互不為上下游：推播失敗不該害日誌沒寫，反之亦然。"""
    tasks = {t.task_id: t for t in dagbag.dags["sunset_daily"].tasks}
    assert tasks["fetch_and_score"].downstream_task_ids == {"write_logbook", "broadcast"}
    assert tasks["write_logbook"].downstream_task_ids == set()
    assert tasks["broadcast"].downstream_task_ids == set()

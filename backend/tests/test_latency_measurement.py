"""I1 measurement contracts; fake operations never send task text to a provider."""

import asyncio
import importlib.util
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "measure_latency.py"
SPEC = importlib.util.spec_from_file_location("latency_measurement", SCRIPT)
latency = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(latency)


def sample(**changes):
    return {
        "journey": "analysis",
        "concurrency": 1,
        "source": "browser_fake",
        "phase": "warm",
        "outcome": "ok",
        "ms": 10,
        **changes,
    }


def test_percentiles_and_empty_cells_are_explicit():
    assert latency.percentile(list(range(1, 21)), 50) == 10
    assert latency.percentile(list(range(1, 21)), 95) == 19
    assert latency.percentile([7], 95) == 7
    assert latency.percentile([], 95) is None
    cells = latency.summarise([])
    assert len(cells) == 12
    assert all(c["p95_ms"] is None and c["attempted"] == 0 for c in cells)


def test_failures_never_improve_success_percentiles_and_phases_stay_separate():
    cells = latency.summarise(
        [
            sample(ms=50),
            sample(outcome="error", ms=1),
            sample(outcome="rate_limited", ms=2),
            sample(phase="idle_30m", ms=900),
            sample(source="browser_live", ms=800),
        ]
    )
    cell = next(
        c
        for c in cells
        if c["journey"] == "analysis"
        and c["source"] == "browser_fake"
        and c["phase"] == "warm"
        and c["concurrency"] == 1
    )
    assert cell["attempted"] == 3
    assert cell["successful"] == 1
    assert sum(cell["outcomes"].values()) == 3
    assert cell["p95_ms"] == 50
    assert cell["limitation"] == "small_sample"


@pytest.mark.parametrize(
    "change",
    [
        {"task": "CONFIDENTIAL_MARKER"},
        {"error": "CONFIDENTIAL_MARKER"},
        {"journey": "CONFIDENTIAL_MARKER"},
        {"source": "unknown"},
        {"phase": "cold"},
        {"outcome": "provider-secret"},
        {"ms": float("nan")},
        {"ms": -1},
        {"ms": True},
        {"concurrency": True},
        {"concurrency": 21},
        {"source": "api"},
    ],
)
def test_import_boundary_rejects_raw_text_and_invalid_measurements(change):
    with pytest.raises(ValueError) as error:
        latency.validate_sample(sample(**change))
    assert "CONFIDENTIAL_MARKER" not in str(error.value)


async def test_twenty_overlapping_requests_account_for_all_outcomes():
    active = peak = launched = 0
    ready = asyncio.Event()

    async def operation():
        nonlocal active, peak, launched
        active += 1
        launched += 1
        this_attempt = launched
        peak = max(peak, active)
        if active == 20:
            ready.set()
        try:
            await ready.wait()
            if this_attempt == 1:
                raise RuntimeError("CONFIDENTIAL_MARKER")
            return "cancelled" if this_attempt == 2 else "ok"
        finally:
            active -= 1

    results = await latency.collect(operation, concurrency=20, attempts=20, deadline_seconds=2)
    assert peak == 20 and active == 0
    assert len(results) == launched == 20
    assert sum(r["outcome"] == "ok" for r in results) == 18
    assert "CONFIDENTIAL_MARKER" not in str(results)


async def test_quota_failure_stops_new_launches_and_honours_budget():
    async def limited():
        return "rate_limited"

    results = await latency.collect(limited, concurrency=1, attempts=30, deadline_seconds=1)
    assert len(results) == 1 and results[0]["outcome"] == "rate_limited"

    async def successful():
        await asyncio.sleep(0)
        return "ok"

    assert (
        len(await latency.collect(successful, concurrency=20, attempts=3, deadline_seconds=1)) == 3
    )


async def test_hanging_operation_has_a_terminal_timeout_and_no_further_launches():
    async def hang():
        await asyncio.Event().wait()

    results = await latency.collect(hang, concurrency=1, attempts=9, deadline_seconds=0.02)
    assert len(results) == 1 and results[0]["outcome"] == "timeout"


async def test_cancelled_operation_is_accounted_for_without_replacement():
    async def cancelled():
        raise asyncio.CancelledError

    results = await latency.collect(cancelled, concurrency=1, attempts=3, deadline_seconds=1)
    assert len(results) == 1 and results[0]["outcome"] == "cancelled"


@pytest.mark.parametrize(
    "url",
    [
        "http://example.com",
        "https://user:secret@example.com",
        "https://example.com?q=secret",
        "https://example.com/#secret",
        "https://example.com/api/analyze",
        "file:///tmp/example",
    ],
)
def test_probe_refuses_credentials_paths_and_remote_plain_http(url):
    with pytest.raises(ValueError):
        latency.health_url(url)


def test_probe_has_one_fixed_read_only_application_path():
    assert latency.health_url("http://127.0.0.1:8100") == "http://127.0.0.1:8100/api/health"
    assert latency.health_url("https://example.com/") == "https://example.com/api/health"


def test_comparison_discloses_unknown_configuration_and_changed_sample_sizes():
    before = latency.make_report([sample()])
    after = latency.make_report([sample(), sample()])
    result = latency.comparison(before, after)
    assert not result["comparable"]
    assert "unverified_configuration" in result["differences"]
    assert "capture_matrix_or_sample_sizes" in result["differences"]


async def test_invalid_run_parameters_launch_nothing():
    async def forbidden():
        pytest.fail("invalid configuration must not start any work")

    with pytest.raises(ValueError):
        await latency.collect(forbidden, concurrency=21, attempts=1, deadline_seconds=1)
    with pytest.raises(ValueError):
        await latency.collect(forbidden, concurrency=1, attempts=0, deadline_seconds=1)

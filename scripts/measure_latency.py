"""Bounded I1 diagnostics. Never call a provider directly or retain request/response text."""

import argparse
import asyncio
import ipaddress
import json
import math
import re
import subprocess
from collections import Counter
from datetime import UTC, datetime
from pathlib import Path
from time import perf_counter
from urllib.parse import urlsplit

import httpx

JOURNEYS = ("page_change", "analysis", "chat_first_text", "ide_load")
CONCURRENCIES = (1, 5, 20)
OUTCOMES = ("ok", "error", "timeout", "cancelled", "rate_limited")
SOURCES = ("simulated", "api", "browser_fake", "browser_live", "ide_host")
FIELDS = {"journey", "concurrency", "source", "phase", "outcome", "ms"}


def validate_sample(value):
    """Strict numeric/enum boundary: no imported bodies, identifiers or error details."""
    if not isinstance(value, dict) or set(value) != FIELDS:
        raise ValueError("Capture must contain exactly the documented timing fields")
    if value["journey"] not in (*JOURNEYS, "api_health"):
        raise ValueError("Unknown journey")
    if type(value["concurrency"]) is not int or value["concurrency"] not in CONCURRENCIES:
        raise ValueError("Concurrency must be 1, 5 or 20")
    if value["source"] not in SOURCES or value["phase"] not in ("warm", "idle_30m"):
        raise ValueError("Unknown source or phase")
    if value["outcome"] not in OUTCOMES:
        raise ValueError("Unknown outcome")
    duration = value["ms"]
    if type(duration) not in (int, float) or not math.isfinite(duration) or duration < 0:
        raise ValueError("Duration must be a finite non-negative number")
    if value["source"] == "api" and value["journey"] != "api_health":
        raise ValueError("API health timings cannot represent a visible journey")
    return dict(value)


def percentile(values, percent):
    if not values:
        return None
    ordered = sorted(values)
    return ordered[max(0, math.ceil(len(ordered) * percent / 100) - 1)]


def summarise(samples):
    samples = [validate_sample(sample) for sample in samples]
    cells = []
    # Keep sources and warm/cold phases separate, including an explicit missing matrix.
    sources = sorted({s["source"] for s in samples}) or ["simulated"]
    phases = sorted({s["phase"] for s in samples}) or ["warm"]
    journeys = (
        (*JOURNEYS, "api_health")
        if any(s["journey"] == "api_health" for s in samples)
        else JOURNEYS
    )
    for source in sources:
        for phase in phases:
            for journey in journeys:
                for concurrency in CONCURRENCIES:
                    found = [
                        s
                        for s in samples
                        if (s["source"], s["phase"], s["journey"], s["concurrency"])
                        == (source, phase, journey, concurrency)
                    ]
                    durations = [s["ms"] for s in found if s["outcome"] == "ok"]
                    cells.append(
                        {
                            "source": source,
                            "phase": phase,
                            "journey": journey,
                            "concurrency": concurrency,
                            "attempted": len(found),
                            "outcomes": dict(Counter(s["outcome"] for s in found)),
                            "successful": len(durations),
                            "p50_ms": percentile(durations, 50),
                            "p95_ms": percentile(durations, 95),
                            "limitation": "no_successful_samples"
                            if not durations
                            else ("small_sample" if len(durations) < 20 else "descriptive_only"),
                        }
                    )
    return cells


def comparison(baseline, current):
    """Do not silently compare different protocols, sources or concurrency settings."""
    keys = ("protocol", "environment", "model", "versions", "rounds")
    mismatches = [key for key in keys if baseline.get(key) != current.get(key)]

    def shape(report):
        return sorted(
            (c["source"], c["phase"], c["journey"], c["concurrency"], c["successful"])
            for c in report["cells"]
        )

    if any(current.get(key) in (None, "not_recorded") for key in ("model", "versions")):
        mismatches.append("unverified_configuration")
    if shape(baseline) != shape(current):
        mismatches.append("capture_matrix_or_sample_sizes")
    return {"comparable": not mismatches, "differences": mismatches}


def health_url(base):
    parsed = urlsplit(base)
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError("Credentials, query strings and fragments are forbidden")
    if parsed.path not in ("", "/") or not parsed.hostname:
        raise ValueError("Supply an origin, not a path")
    try:
        local = ipaddress.ip_address(parsed.hostname).is_loopback
    except ValueError:
        local = parsed.hostname == "localhost"
    if parsed.scheme != "https" and not (parsed.scheme == "http" and local):
        raise ValueError("Remote targets require HTTPS")
    return base.rstrip("/") + "/api/health"


async def collect(operation, *, concurrency, attempts, deadline_seconds):
    """Count every launched attempt; stop new work after an observed quota failure."""
    if (
        type(concurrency) is not int
        or concurrency not in CONCURRENCIES
        or type(attempts) is not int
        or attempts < 1
    ):
        raise ValueError("Invalid concurrency or attempt budget")
    if not math.isfinite(deadline_seconds) or deadline_seconds <= 0:
        raise ValueError("Deadline must be positive")
    end = perf_counter() + deadline_seconds
    launched, stop = 0, False
    results = []

    async def worker():
        nonlocal launched, stop
        while not stop and launched < attempts:
            remaining = end - perf_counter()
            if remaining <= 0:
                break
            launched += 1
            started = perf_counter()
            try:
                outcome = await asyncio.wait_for(operation(), remaining)
                if outcome not in OUTCOMES:
                    outcome = "error"
            except TimeoutError:
                outcome = "timeout"
            except asyncio.CancelledError:
                # Record cancellation, then honour it without launching replacements.
                results.append({"outcome": "cancelled", "ms": (perf_counter() - started) * 1000})
                stop = True
                if asyncio.current_task().cancelling():
                    raise
                return
            except Exception:
                outcome = "error"  # Never retain exception text or traceback.
            results.append({"outcome": outcome, "ms": (perf_counter() - started) * 1000})
            if outcome == "rate_limited":
                stop = True

    await asyncio.gather(*(worker() for _ in range(min(concurrency, attempts))))
    return results


def build_identity():
    """Only retain a revision hash and a dirty flag, never filenames or git error text."""
    try:
        commit = subprocess.run(
            ["git", "rev-parse", "HEAD"], capture_output=True, text=True, timeout=5, check=True
        ).stdout.strip()
        if not re.fullmatch(r"[0-9a-f]{40,64}", commit):
            return {"commit": "not_recorded", "dirty": True}
        dirty = bool(
            subprocess.run(
                ["git", "status", "--porcelain"],
                capture_output=True,
                text=True,
                timeout=5,
                check=True,
            ).stdout
        )
        return {"commit": commit, "dirty": dirty}
    except (OSError, subprocess.SubprocessError):
        return {"commit": "not_recorded", "dirty": True}


def identity_tag(value):
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}", value):
        raise argparse.ArgumentTypeError("Use a short model/version identifier, never free text")
    return value


def make_report(
    samples,
    *,
    environment="local",
    rounds=5,
    model="not_recorded",
    versions="not_recorded",
    build=None,
):
    return {
        "protocol": "ws1-latency-1",
        "created_at": datetime.now(UTC).isoformat(),
        "environment": environment,
        "model": model,
        "versions": versions,
        "build": build or {"commit": "not_recorded", "dirty": True},
        "rounds": rounds,
        "cells": summarise(samples),
        "samples": samples,
        "limits": [
            "No SLA conclusion; missing cells remain unavailable",
            "Simulated results do not measure production LLM latency",
            "API and IDE host timings do not prove visible rendering latency",
        ],
    }


async def run(args):
    samples = []
    if args.mode == "import":
        for path in args.capture:
            # Refuse oversized files before reading; captures must be metadata only.
            if path.stat().st_size > 2_000_000:
                raise ValueError("Capture exceeds the 2 MB limit")
            for line in path.read_text(encoding="utf-8").splitlines():
                if line.strip():
                    samples.append(validate_sample(json.loads(line)))
    else:
        url = health_url(args.base_url) if args.mode == "probe" else None
        remaining = args.budget
        async with httpx.AsyncClient(follow_redirects=False, trust_env=False) as client:

            async def operation():
                if url is None:
                    await asyncio.sleep(0.001)
                    return "ok"
                try:
                    response = await client.get(url, timeout=args.timeout)
                except httpx.TimeoutException:
                    return "timeout"
                if response.status_code == 429:
                    return "rate_limited"
                return "ok" if response.status_code == 200 else "error"

            for concurrency in CONCURRENCIES:
                if remaining <= 0:
                    break
                results = await collect(
                    operation,
                    concurrency=concurrency,
                    attempts=min(args.rounds * concurrency, remaining),
                    deadline_seconds=args.timeout,
                )
                remaining -= len(results)
                samples.extend(
                    {
                        "journey": "api_health",
                        "source": "api" if url else "simulated",
                        "phase": "warm",
                        "concurrency": concurrency,
                        **result,
                    }
                    for result in results
                )
                if any(r["outcome"] == "rate_limited" for r in results):
                    break
    return make_report(
        samples,
        environment=args.environment,
        rounds=args.rounds,
        model=args.model,
        versions=args.versions,
        build=build_identity(),
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mode", choices=("simulate", "probe", "import"), default="simulate")
    parser.add_argument("--base-url")
    parser.add_argument("--capture", type=Path, action="append", default=[])
    parser.add_argument("--model", type=identity_tag, default="not_recorded")
    parser.add_argument("--versions", type=identity_tag, default="not_recorded")
    parser.add_argument(
        "--environment", choices=("local", "preview", "production"), default="local"
    )
    parser.add_argument("--rounds", type=int, choices=range(1, 21), default=5)
    parser.add_argument("--budget", type=int, choices=range(1, 1001), default=130)
    parser.add_argument("--timeout", type=float, default=30)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.mode == "probe" and not args.base_url:
        parser.error("probe requires an explicit --base-url")
    if args.mode == "import" and not args.capture:
        parser.error("import requires --capture")
    if not math.isfinite(args.timeout) or args.timeout <= 0:
        parser.error("timeout must be positive and finite")
    try:
        report = asyncio.run(run(args))
        # Output is written only after the entire input passes the privacy boundary.
        args.output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    except (ValueError, OSError, httpx.HTTPError):
        parser.exit(
            2, "Measurement failed; check target/settings/capture without sharing secrets.\n"
        )


if __name__ == "__main__":
    main()

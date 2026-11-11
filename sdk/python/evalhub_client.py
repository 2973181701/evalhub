"""
EvalHub Python 客户端（零依赖，只用标准库 urllib）

为什么还要一个 Python SDK：训练侧、数据侧、DocGuard 那条业务线都是 Python。
一份只有 JS 的 SDK 等于把半个公司的调用方挡在门外。

用法::

    from evalhub_client import EvalHubClient

    client = EvalHubClient(base_url="http://127.0.0.1:3000", api_key=os.environ["EVALHUB_API_KEY"])
    run = client.create_run(provider="glm")
    done = client.wait_run(run["id"])
    agg = client.aggregate(run["id"])
    print(agg["total"], agg["dims"])

    # 门禁（与 CI 脚本用同一份服务端口径，结论不会两套）
    gate = client.gate(key="evalhub-core", scores=client.results(run["id"]))
    if not gate["pass"]:
        raise SystemExit("门禁未通过: " + "; ".join(gate["reasons"]))

限流：服务端按 key 每分钟计数，超限返回 429 并带 Retry-After。
本客户端把状态码、retry_after 都挂在异常上，调用方可以据此退避。
"""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
from typing import Any, Callable, Dict, Iterable, List, Optional

__all__ = ["EvalHubClient", "EvalHubError", "DIMS"]

DIMS = ["accuracy", "completeness", "logic", "safety", "expression"]


class EvalHubError(Exception):
    """接口错误。status 为 HTTP 码（0 表示网络层失败）。"""

    def __init__(self, message: str, status: int = 0, path: str = "",
                 body: Optional[dict] = None, retry_after: Optional[int] = None):
        super().__init__(message)
        self.status = status
        self.path = path
        self.body = body
        self.retry_after = retry_after

    def __str__(self) -> str:  # pragma: no cover - 便于日志
        base = super().__str__()
        return f"{base} (HTTP {self.status}{', retry after %ss' % self.retry_after if self.retry_after else ''})"


class EvalHubClient:
    """评测平台客户端。api_key 与 token 二选一。"""

    def __init__(self, base_url: str = "http://127.0.0.1:3000",
                 api_key: Optional[str] = None, token: Optional[str] = None,
                 tenant: Optional[str] = None, timeout: float = 60.0):
        if not api_key and not token:
            raise ValueError("需要 api_key 或 token 之一")
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.token = token
        self.tenant = tenant
        self.timeout = timeout

    # ── HTTP 基础 ──────────────────────────────────────────────
    def _headers(self) -> Dict[str, str]:
        headers = {
            "Content-Type": "application/json",
            # API Key 与 JWT 都走 Bearer；服务端按前缀区分
            "Authorization": "Bearer %s" % (self.api_key or self.token),
        }
        if self.tenant:
            headers["X-Tenant"] = self.tenant
        return headers

    def _request(self, path: str, method: str = "GET", body: Optional[dict] = None) -> Any:
        data = None if body is None else json.dumps(body).encode("utf-8")
        req = urllib.request.Request(
            self.base_url + path, data=data, method=method, headers=self._headers(),
        )
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                raw = resp.read().decode("utf-8")
        except urllib.error.HTTPError as e:
            raw = e.read().decode("utf-8", "replace")
            payload = None
            try:
                payload = json.loads(raw)
            except ValueError:
                pass
            retry_after = e.headers.get("Retry-After") if e.headers else None
            raise EvalHubError(
                (payload or {}).get("error") or ("HTTP %s" % e.code),
                status=e.code, path=path, body=payload,
                retry_after=int(retry_after) if retry_after and retry_after.isdigit() else None,
            ) from None
        except urllib.error.URLError as e:
            raise EvalHubError("请求失败：%s（%s %s）" % (e.reason, method, path), path=path) from None

        try:
            payload = json.loads(raw)
        except ValueError:
            raise EvalHubError("后端返回非 JSON", status=0, path=path) from None
        if not payload.get("ok"):
            raise EvalHubError(payload.get("error") or "未知错误", path=path, body=payload)
        return payload.get("data")

    # ── 基础能力 ──────────────────────────────────────────────
    def health(self) -> dict:
        return self._request("/api/health")

    def create_run(self, provider: str = "local", model: Optional[str] = None,
                   ids: Optional[Iterable[str]] = None, config: Optional[dict] = None) -> dict:
        payload: Dict[str, Any] = {"provider": provider, "config": config or {}}
        if model:
            payload["model"] = model
        if ids:
            payload["ids"] = list(ids)
        return self._request("/api/runs", method="POST", body=payload)

    def get_run(self, run_id: str) -> dict:
        return self._request("/api/runs/%s" % run_id)

    def results(self, run_id: str) -> List[dict]:
        """逐条结果。服务端返回 {count, rows} 信封，这里归一化成 list。"""
        data = self._request("/api/runs/%s/results" % run_id)
        if isinstance(data, list):
            return data
        return list((data or {}).get("rows") or [])

    def cancel_run(self, run_id: str) -> dict:
        return self._request("/api/runs/%s/cancel" % run_id, method="POST")

    def compare(self, run_a: str, run_b: str) -> dict:
        return self._request("/api/runs/%s/compare/%s" % (run_a, run_b))

    def rubrics(self) -> List[dict]:
        return self._request("/api/rubrics")

    def gate(self, key: str, scores: List[dict], version: Optional[int] = None) -> dict:
        return self._request("/api/rubrics/gate", method="POST",
                             body={"key": key, "version": version, "scores": scores})

    # ── 组合能力 ──────────────────────────────────────────────
    def wait_run(self, run_id: str, timeout: float = 600.0, interval: float = 1.0,
                 on_progress: Optional[Callable[[dict], None]] = None) -> dict:
        """轮询到终态。只在 queued/running 时继续，终态立即返回。"""
        deadline = time.monotonic() + timeout
        while True:
            run = self.get_run(run_id)
            if on_progress:
                on_progress(run)
            if run.get("status") in ("succeeded", "failed", "canceled"):
                return run
            if time.monotonic() > deadline:
                raise EvalHubError(
                    "等待任务超时（%ss）：%s，仍为 %s" % (timeout, run_id, run.get("status")),
                    path="/api/runs/%s" % run_id,
                )
            time.sleep(interval)

    def aggregate(self, run_id: str) -> dict:
        """
        五维 + 总分均值。
        只统计有分数的行：失败条目 total 为 None，当 0 会把均分稀释成假的低分。
        """
        rows = self.results(run_id)
        ok = [r for r in rows if r.get("total") is not None]
        if not ok:
            return {"n": 0, "failed": len(rows), "total": None,
                    "dims": {d: None for d in DIMS}}
        n = len(ok)

        def mean(values: Iterable[float]) -> float:
            vals = [float(v) for v in values]
            return round(sum(vals) / len(vals), 3)

        return {
            "n": n,
            "failed": len(rows) - n,
            "total": mean([r["total"] for r in ok]),
            "dims": {d: mean([r.get(d) or 0 for r in ok]) for d in DIMS},
        }

    def run_and_aggregate(self, provider: str = "local", ids: Optional[Iterable[str]] = None,
                          config: Optional[dict] = None, timeout: float = 600.0,
                          on_progress: Optional[Callable[[dict], None]] = None) -> dict:
        run = self.create_run(provider=provider, ids=ids, config=config)
        done = self.wait_run(run["id"], timeout=timeout, on_progress=on_progress)
        return {"run": done, "aggregate": self.aggregate(run["id"])}

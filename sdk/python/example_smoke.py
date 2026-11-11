"""
最小可用示例：用 Python SDK 跑一次评测并做门禁判定。

    export EVALHUB_BASE=http://127.0.0.1:3000
    export EVALHUB_API_KEY=ehk_xxx
    python sdk/python/example_smoke.py

退出码：0 通过 / 2 门禁不通过 / 1 出错。
"""

import os
import sys

from evalhub_client import EvalHubClient, EvalHubError


def main() -> int:
    client = EvalHubClient(
        base_url=os.environ.get("EVALHUB_BASE", "http://127.0.0.1:3000"),
        api_key=os.environ.get("EVALHUB_API_KEY"),
        tenant=os.environ.get("EVALHUB_TENANT") or None,
    )

    health = client.health()
    tenant = health["tenant"]
    print("业务线 %s（%s）· 存储 %s" % (
        tenant["slug"], "强制" if tenant["enforced"] else "未强制", health["storage"]["mode"],
    ))

    ids = os.environ.get("EVALHUB_IDS", "K01,K02,K03").split(",")
    print("跑评测：provider=local，题号 %s" % ",".join(ids))
    out = client.run_and_aggregate(provider="local", ids=ids)
    run, agg = out["run"], out["aggregate"]

    print("  任务 %s 状态 %s，样本 %d 条" % (run["id"][:8], run["status"], agg["n"]))
    print("  总分 %.3f  五维 %s" % (agg["total"], agg["dims"]))

    gate = client.gate(key=os.environ.get("EVALHUB_RUBRIC", "evalhub-core"),
                       scores=client.results(run["id"]))
    if gate["pass"]:
        print("门禁通过 ✓")
        return 0
    print("门禁未通过：")
    for reason in gate["reasons"]:
        print("  - %s" % reason)
    return 2


if __name__ == "__main__":
    try:
        sys.exit(main())
    except EvalHubError as e:
        print("接口错误：%s" % e, file=sys.stderr)
        sys.exit(1)

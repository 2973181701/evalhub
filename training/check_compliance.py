"""
回答规范性检查（确定性，不调用任何模型）

为什么需要它：平台的规则评分（accuracy 靠词面重合）**天然偏爱长答案**。
用它评估"把答案变简洁"的微调，结论必然是"变差"，这与实际目标相反。
所以要有一个只问"回答是否符合要求"的指标：

  1. 非空
  2. 无元话语（"当然可以！下面是一个…"这类开场）
  3. 不过度冗长（事实/情感题超过 80 字即视为啰嗦）
  4. 代码题：能抽出代码块并被 Python 解析通过
  5. 标签题：恰好给出 正面/负面/中性 之一
  6. 两步题：两步都答到（先判断前提，再回答结论）

这些判据全部可复算、可解释，不看长度给分、不依赖模型偏好。

用法：
    python training/check_compliance.py data/answers/qwen_base.json data/answers/qwen_ft.json
"""

from __future__ import annotations

import argparse
import ast
import json
import re
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent

META_PREFIX = re.compile(r"^(当然可以|好的|以下是|下面是|根据(题目|参考)|我们来|首先|这道题)")
LABEL_RE = re.compile(r"(正面|负面|中性)")
CODE_BLOCK = re.compile(r"```(?:python)?\s*(.+?)```", re.S)


def check_answer(item: dict, answer: str) -> dict:
    """返回 {checks: {name: bool}, length: int}；checks 全 True 才算合规"""
    text = (answer or "").strip()
    task = item.get("task_type", "")
    checks: dict[str, bool] = {}

    checks["非空"] = len(text) > 0
    checks["无元话语"] = not META_PREFIX.match(text)

    # 简单事实题与标签题，超过 80 字基本就是跑了题
    if task in ("事实问答", "情感分析", "逻辑推理"):
        checks["不过度冗长"] = len(text) <= 80
    else:
        checks["不过度冗长"] = len(text) <= 400

    if task == "代码生成":
        m = CODE_BLOCK.search(text)
        code = m.group(1) if m else text
        try:
            ast.parse(code)
            checks["代码可解析"] = True
        except SyntaxError:
            checks["代码可解析"] = False

    if task == "情感分析":
        # 只允许出现一个标签，且整段不能是一句解释
        hits = set(LABEL_RE.findall(text))
        checks["只给标签"] = len(hits) == 1 and len(text) <= 6

    if item.get("id") == "R02":
        # 题目明确要求两步：先判断前提是否正确，再回答企鹅会不会飞
        has_step1 = any(k in text for k in ("前提", "不正确", "错误", "不成立"))
        has_step2 = "不会飞" in text or ("不" in text and "飞" in text)
        checks["两步都答"] = has_step1 and has_step2

    return {"checks": checks, "length": len(text)}


def summarize(path: Path) -> dict:
    payload = json.loads(path.read_text(encoding="utf-8"))
    items = {x["id"]: x for x in json.loads((ROOT / "data" / "prompts.json").read_text(encoding="utf-8"))}
    rows = []
    for a in payload["answers"]:
        item = items.get(a["id"], {})
        r = check_answer(item, a["answer"])
        passed = all(r["checks"].values())
        rows.append({
            "id": a["id"],
            "task_type": item.get("task_type", ""),
            "length": r["length"],
            "passed": passed,
            "failed_checks": [k for k, v in r["checks"].items() if not v],
        })

    per_check: dict[str, int] = {}
    for r in rows:
        for name in r["failed_checks"]:
            per_check[name] = per_check.get(name, 0) + 1

    task_stats: dict[str, dict] = {}
    for r in rows:
        t = task_stats.setdefault(r["task_type"], {"n": 0, "pass": 0})
        t["n"] += 1
        t["pass"] += 1 if r["passed"] else 0

    return {
        "file": path.name,
        "model": payload.get("model"),
        "adapter": payload.get("adapter"),
        "n": len(rows),
        "passed": sum(1 for r in rows if r["passed"]),
        "pass_rate": round(sum(1 for r in rows if r["passed"]) / max(1, len(rows)) * 100, 1),
        "avg_length": round(sum(r["length"] for r in rows) / max(1, len(rows)), 1),
        "fail_by_check": per_check,
        "by_task_type": task_stats,
        "rows": rows,
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("files", nargs="+")
    ap.add_argument("--out", default=str(HERE / "out" / "compliance.json"))
    args = ap.parse_args()

    results = [summarize(Path(f) if Path(f).is_absolute() else ROOT / f) for f in args.files]

    print(f"{'文件':22}{'样本':>5}{'合规':>6}{'合规率':>8}{'平均字数':>9}")
    for r in results:
        print(f"{r['file']:22}{r['n']:>5}{r['passed']:>6}{r['pass_rate']:>7}%{r['avg_length']:>9}")
    for r in results:
        if r["fail_by_check"]:
            print(f"  {r['file']} 未通过项：{r['fail_by_check']}")
        by_task = {k: str(v["pass"]) + "/" + str(v["n"]) for k, v in r["by_task_type"].items()}
        print("  " + r["file"] + " 分题型：" + str(by_task))

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n已写入 {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

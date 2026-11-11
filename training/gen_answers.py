"""
用本地 Qwen3 生成评测集回答（base 或加载 LoRA 适配器）

产出格式直接对齐 EvalHub 的 data/answers/*.json，平台里用 provider=file 就能评分：
    POST /api/runs {"provider":"file","config":{"answers":"qwen_base.json"}}

为什么不在训练脚本里顺手评测：
  生成回答是「推理」，训练是「优化」，两者的显存与依赖都不同。拆开之后，
  同一份回答文件可以被反复评分、被不同口径判定，不必重跑模型 —— 这也是
  评测平台该有的样子：模型只负责产样本，评分与对比交给平台。

用法：
    python training/gen_answers.py --model D:/evalhub-train/models/Qwen3-1.7B --out data/answers/qwen_base.json
    python training/gen_answers.py --model ... --adapter training/out/adapter --out data/answers/qwen_ft.json
"""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser()
    p.add_argument("--model", default="D:/evalhub-train/models/Qwen3-1.7B")
    p.add_argument("--adapter", default=None)
    p.add_argument("--prompts", default=str(ROOT / "data" / "prompts.json"))
    p.add_argument("--out", required=True)
    p.add_argument("--max-new-tokens", type=int, default=256)
    p.add_argument("--temperature", type=float, default=0.0, help="0 表示贪心解码，便于复现")
    p.add_argument("--ids", default=None, help="只跑指定题号，逗号分隔")
    p.add_argument("--limit", type=int, default=0)
    return p.parse_args()


def main() -> int:
    args = parse_args()

    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer

    if not torch.cuda.is_available():
        raise SystemExit("CUDA 不可用，本地推理会慢到没有意义；请检查 torch 与驱动")

    print(f"加载模型 {args.model}")
    tokenizer = AutoTokenizer.from_pretrained(args.model, trust_remote_code=True)
    model = AutoModelForCausalLM.from_pretrained(
        args.model, trust_remote_code=True, torch_dtype=torch.float16, device_map={"": 0},
    )

    if args.adapter:
        from peft import PeftModel
        print(f"加载适配器 {args.adapter}")
        model = PeftModel.from_pretrained(model, args.adapter)
        model = model.merge_and_unload()   # 合并后推理更快，也避免 PEFT 前向的额外开销
    model.eval()

    prompts = json.loads(Path(args.prompts).read_text(encoding="utf-8"))
    if args.ids:
        wanted = {x.strip() for x in args.ids.split(",") if x.strip()}
        prompts = [p for p in prompts if p["id"] in wanted]
    if args.limit:
        prompts = prompts[: args.limit]
    print(f"待生成 {len(prompts)} 题")

    answers = []
    for i, item in enumerate(prompts, 1):
        messages = [{"role": "user", "content": item["prompt"]}]
        try:
            # Qwen3 支持关闭 thinking；模板不认这个参数时退回普通渲染
            text = tokenizer.apply_chat_template(
                messages, tokenize=False, add_generation_prompt=True, enable_thinking=False,
            )
        except TypeError:
            text = tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)

        inputs = tokenizer([text], return_tensors="pt").to(model.device)
        t0 = time.time()
        with torch.no_grad():
            out = model.generate(
                **inputs,
                max_new_tokens=args.max_new_tokens,
                do_sample=args.temperature > 0,
                temperature=args.temperature if args.temperature > 0 else None,
                pad_token_id=tokenizer.eos_token_id,
            )
        latency_ms = int((time.time() - t0) * 1000)

        new_tokens = out[0][inputs["input_ids"].shape[1]:]
        answer = tokenizer.decode(new_tokens, skip_special_tokens=True).strip()
        answers.append({
            "id": item["id"],
            "task_type": item["task_type"],
            "prompt": item["prompt"],
            "answer": answer,
            "latency_ms": latency_ms,
            "output_tokens": int(new_tokens.shape[0]),
        })
        print(f"  [{i}/{len(prompts)}] {item['id']} {latency_ms}ms {len(answer)}字 :: {answer[:40]}")

    out_path = Path(args.out)
    if not out_path.is_absolute():
        out_path = ROOT / out_path
    out_path.parent.mkdir(parents=True, exist_ok=True)

    payload = {
        "model": args.model,
        "adapter": args.adapter,
        "decoding": "greedy" if args.temperature == 0 else f"sample(temp={args.temperature})",
        "max_new_tokens": args.max_new_tokens,
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "count": len(answers),
        "avg_latency_ms": int(sum(a["latency_ms"] for a in answers) / max(1, len(answers))),
        "avg_answer_chars": round(sum(len(a["answer"]) for a in answers) / max(1, len(answers)), 1),
        "answers": answers,
    }
    out_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n已写入 {out_path}（{len(answers)} 条，平均 {payload['avg_latency_ms']}ms / {payload['avg_answer_chars']} 字）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

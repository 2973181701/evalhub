"""
Qwen3-1.7B LoRA / QLoRA 微调（单卡 8GB 可跑）

设计取舍，都是被这台机器逼出来的：

1. **不用 TRL 的 SFTTrainer**。TRL 的版本间 API 变动很大，而且默认会把整段对话都算进 loss。
   这里手写 label mask：只在 assistant 段计 loss，prompt 段置 -100。这样模型学的是
   「怎么回答」，而不是「怎么复述题目」。

2. **默认 fp16 LoRA，4-bit 作为可选**。1.7B 的 fp16 权重约 3.4GB，加激活在 8GB 卡上是安全的；
   bitsandbytes 在 Windows + Python 3.13 上不保证有轮子，装不上就退到 fp16——
   宁可显存多占 1GB，也不要卡在环境上跑不起来。

3. **显存不够就缩短序列**，而不是静默 OOM。这批样本平均 16 字，512 token 绰绰有余，
   默认就设 512，给激活留余量。

用法：
    python training/train_qlora.py --model Qwen/Qwen3-1.7B --epochs 3
    python training/train_qlora.py --load-in-4bit          # 显存更紧时
    python training/train_qlora.py --dry-run               # 只验证数据与分词，不训练
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser()
    p.add_argument("--model", default="Qwen/Qwen3-1.7B")
    p.add_argument("--train-file", default=str(HERE / "data" / "train.jsonl"))
    p.add_argument("--out-dir", default=str(HERE / "out"))
    p.add_argument("--epochs", type=float, default=3.0)
    p.add_argument("--batch-size", type=int, default=1)
    p.add_argument("--grad-accum", type=int, default=8)
    p.add_argument("--lr", type=float, default=2e-4)
    p.add_argument("--max-len", type=int, default=512)
    p.add_argument("--lora-r", type=int, default=16)
    p.add_argument("--lora-alpha", type=int, default=32)
    p.add_argument("--load-in-4bit", action="store_true")
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--seed", type=int, default=42)
    return p.parse_args()


def load_records(path: str) -> list[dict]:
    rows = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    if not rows:
        raise SystemExit(f"训练集为空：{path}")
    return rows


def build_example(tokenizer, messages: list[dict], max_len: int) -> dict:
    """
    手工构造 input_ids / labels：
      - 用 tokenizer 的 chat template 渲染整段对话
      - 再单独渲染「只有 prompt」的部分，其长度即为需要 mask 的前缀长度
    这样能精确只在 assistant 回复上算 loss，且不依赖 TRL 的内部实现。
    """
    full_text = tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=False)
    prompt_text = tokenizer.apply_chat_template(
        messages[:-1], tokenize=False, add_generation_prompt=True,
    )

    full = tokenizer(full_text, truncation=True, max_length=max_len, add_special_tokens=False)
    prompt_ids = tokenizer(prompt_text, truncation=True, max_length=max_len, add_special_tokens=False)["input_ids"]

    input_ids = full["input_ids"]
    labels = list(input_ids)
    prefix = min(len(prompt_ids), len(labels))
    for i in range(prefix):
        labels[i] = -100
    # 整段都被 mask 掉（样本比 prompt 还短）时无法学习，直接丢弃
    if all(x == -100 for x in labels):
        return {}
    return {
        "input_ids": input_ids,
        "attention_mask": full["attention_mask"],
        "labels": labels,
    }


def main() -> int:
    args = parse_args()
    os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

    records = load_records(args.train_file)
    print(f"训练样本：{len(records)} 条")

    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer
    from transformers import Trainer, TrainingArguments, DataCollatorForSeq2Seq

    print(f"torch {torch.__version__} | cuda 可用 {torch.cuda.is_available()}")
    if torch.cuda.is_available():
        name = torch.cuda.get_device_name(0)
        total = torch.cuda.get_device_properties(0).total_memory / 1024**3
        print(f"GPU: {name} | 显存 {total:.1f} GB")

    # 国内直连 huggingface.co 不通，统一走镜像（已实测 hf-mirror 可用）
    os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")

    tokenizer = AutoTokenizer.from_pretrained(args.model, trust_remote_code=True)
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token

    examples = [build_example(tokenizer, r["messages"], args.max_len) for r in records]
    examples = [e for e in examples if e]
    dropped = len(records) - len(examples)
    print(f"可用样本：{len(examples)} 条" + (f"（丢弃 {dropped} 条：全部 token 被 mask）" if dropped else ""))

    lengths = [len(e["input_ids"]) for e in examples]
    print(f"token 长度：最小 {min(lengths)} / 中位 {sorted(lengths)[len(lengths)//2]} / 最大 {max(lengths)}")

    if args.dry_run:
        sample = examples[0]
        supervised = sum(1 for x in sample["labels"] if x != -100)
        print(f"dry-run：首条样本 supervised token = {supervised} / 总 {len(sample['input_ids'])}")
        print(f"dry-run：首条 label 前缀 mask 长度 = {len(sample['input_ids']) - supervised}")
        print("dry-run 通过，未加载模型权重")
        return 0

    # ── 模型加载 ────────────────────────────────────────────────
    load_kwargs = {"trust_remote_code": True, "torch_dtype": torch.float16}
    if args.load_in_4bit:
        try:
            from transformers import BitsAndBytesConfig
            load_kwargs["quantization_config"] = BitsAndBytesConfig(
                load_in_4bit=True,
                bnb_4bit_compute_dtype=torch.float16,
                bnb_4bit_quant_type="nf4",
                bnb_4bit_use_double_quant=True,
            )
            load_kwargs["device_map"] = {"": 0}
            print("使用 4-bit 量化加载（QLoRA）")
        except Exception as e:  # noqa: BLE001
            print(f"4-bit 不可用（{e}），回退到 fp16 LoRA")

    t0 = time.time()
    model = AutoModelForCausalLM.from_pretrained(args.model, **load_kwargs)
    if not args.load_in_4bit:
        model = model.to("cuda" if torch.cuda.is_available() else "cpu")
    model.config.use_cache = False
    print(f"模型加载耗时 {time.time() - t0:.1f}s")

    from peft import LoraConfig, get_peft_model, prepare_model_for_kbit_training

    if args.load_in_4bit:
        model = prepare_model_for_kbit_training(model)

    targets = ["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"]
    lora = LoraConfig(
        r=args.lora_r,
        lora_alpha=args.lora_alpha,
        lora_dropout=0.05,
        bias="none",
        task_type="CAUSAL_LM",
        target_modules=targets,
    )
    model = get_peft_model(model, lora)

    # LoRA 参数升到 fp32 再训练。
    # 基底是 fp16 时，若 LoRA 也是 fp16，优化器更新容易在 2e-4 这个量级溢出成 NaN；
    # 升 fp32 后 LoRA 参数只占几十 MB，代价可以忽略。
    for _, param in model.named_parameters():
        if param.requires_grad:
            param.data = param.data.float()

    model.print_trainable_parameters()

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    class ListDataset(torch.utils.data.Dataset):
        def __len__(self):
            return len(examples)

        def __getitem__(self, i):
            return examples[i]

    collator = DataCollatorForSeq2Seq(
        tokenizer, model=model, padding=True, label_pad_token_id=-100, return_tensors="pt",
    )

    steps_per_epoch = max(1, (len(examples) + args.batch_size - 1) // args.batch_size)
    total_steps = int(steps_per_epoch * args.epochs // args.grad_accum) or 1

    training_args = TrainingArguments(
        output_dir=str(out_dir / "checkpoints"),
        num_train_epochs=args.epochs,
        per_device_train_batch_size=args.batch_size,
        gradient_accumulation_steps=args.grad_accum,
        learning_rate=args.lr,
        lr_scheduler_type="cosine",
        warmup_steps=max(1, total_steps // 10),
        logging_steps=1,
        save_strategy="no",
        report_to=[],
        fp16=torch.cuda.is_available() and not args.load_in_4bit,
        gradient_checkpointing=True,
        optim="adamw_torch",
        seed=args.seed,
        dataloader_num_workers=0,
    )

    trainer = Trainer(
        model=model,
        args=training_args,
        train_dataset=ListDataset(),
        data_collator=collator,
    )

    print(f"开始训练：{args.epochs} epoch × {steps_per_epoch} step / 累积 {args.grad_accum} ≈ {total_steps} 次更新")
    t1 = time.time()
    result = trainer.train()
    elapsed = time.time() - t1

    adapter_dir = out_dir / "adapter"
    model.save_pretrained(str(adapter_dir))
    tokenizer.save_pretrained(str(adapter_dir))

    peak = torch.cuda.max_memory_allocated() / 1024**3 if torch.cuda.is_available() else 0
    metrics = {
        "model": args.model,
        "samples": len(examples),
        "epochs": args.epochs,
        "max_len": args.max_len,
        "lora_r": args.lora_r,
        "load_in_4bit": bool(args.load_in_4bit),
        "train_loss": round(float(result.training_loss), 4),
        "train_seconds": round(elapsed, 1),
        "steps": int(result.global_step),
        "peak_vram_gb": round(peak, 2),
        "trainable_params": sum(p.numel() for p in model.parameters() if p.requires_grad),
        "total_params": sum(p.numel() for p in model.parameters()),
        "finished_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "log_history": trainer.state.log_history,
    }
    (out_dir / "train_metrics.json").write_text(
        json.dumps(metrics, ensure_ascii=False, indent=2), encoding="utf-8",
    )

    print(f"\n训练完成：loss {metrics['train_loss']} | 耗时 {elapsed/60:.1f} 分钟 | 峰值显存 {peak:.2f} GB")
    print(f"适配器：{adapter_dir}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

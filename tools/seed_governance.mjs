#!/usr/bin/env node
/**
 * 数据中台一键治理：注册规则 → 登记外部事件 → 重建血缘 → 跑质量检查
 *
 * 用法：DATABASE_URL=... node tools/seed_governance.mjs
 * 幂等：规则 upsert、事件 upsert、血缘全量重建，重复执行结果一致。
 */

import { seedRules, runChecks } from '../backend/governance/quality.js';
import { seedEvents, rebuild, knownGaps } from '../backend/governance/lineage.js';
import { closePool } from '../backend/db.js';

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('需要 DATABASE_URL');
    process.exit(1);
  }

  const rules = await seedRules();
  console.log(`规则：${rules.total} 条（新增 ${rules.inserted}，更新 ${rules.updated}）`);

  const events = await seedEvents();
  console.log(`外部血缘事件：${events} 条`);

  const lin = await rebuild();
  console.log(`血缘派生边：${lin.edges} 条`);

  const report = await runChecks();
  console.log(`\n质量检查 #${report.run_id}：
  规则 ${report.total_rules} 条（critical ${report.critical_rules}）
  通过 ${report.passed} / 失败 ${report.failed} / 提示 ${report.warnings}
  质量分 ${report.score}  状态 ${report.status}
  hash ${report.content_hash}`);
  for (const c of report.checks.filter((x) => !x.passed)) {
    console.log(`  [${c.severity}] ${c.key}: ${c.violations} 处`);
  }
  console.log('\n已知血缘缺口：');
  for (const g of knownGaps()) console.log(`  - ${g.gap} → ${g.fix}`);

  await closePool();
}

main().catch(async (e) => {
  console.error('治理脚本失败：', e.message);
  await closePool().catch(() => {});
  process.exit(1);
});

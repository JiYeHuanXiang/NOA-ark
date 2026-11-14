/**
 * 入群自动审批策略的 group_openid → strategy_id 持久缓存。
 *
 * 官方创建策略接口不返回“该群已有策略”的查询入口，重复创建会占用机器人 20 个策略额度；
 * 适配器本地记住每个群最近一次创建的 strategy_id，后续调用走 PATCH 更新。
 */

import { readJson, writeJsonAtomic } from '../store/json-store.js';

interface JoinPolicyFile {
  version?: number;
  strategies?: Record<string, string>;
}

export class JoinStrategyStore {
  private readonly map = new Map<string, string>();

  constructor(
    private readonly file: string,
    private readonly logger: { warn(message: string): void },
  ) {
    const data = readJson<JoinPolicyFile>(this.file, { strategies: {} });
    for (const [groupOpenid, strategyId] of Object.entries(data.strategies ?? {})) {
      if (groupOpenid !== '' && strategyId !== '') this.map.set(groupOpenid, strategyId);
    }
  }

  get(groupOpenid: string): string | undefined {
    return this.map.get(groupOpenid);
  }

  set(groupOpenid: string, strategyId: string): void {
    if (groupOpenid === '' || strategyId === '') return;
    this.map.set(groupOpenid, strategyId);
    this.save();
  }

  delete(groupOpenid: string): void {
    if (this.map.delete(groupOpenid)) this.save();
  }

  /** 删除策略后清理本地点位，避免后续 PATCH 打到已删除的 strategy_id。 */
  deleteByStrategyId(strategyId: string): void {
    let changed = false;
    for (const [groupOpenid, stored] of this.map) {
      if (stored === strategyId) {
        this.map.delete(groupOpenid);
        changed = true;
      }
    }
    if (changed) this.save();
  }

  private save(): void {
    try {
      writeJsonAtomic(this.file, {
        version: 1,
        strategies: Object.fromEntries(this.map),
      });
    } catch (err) {
      this.logger.warn(`[noa] 写入群审批策略缓存失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

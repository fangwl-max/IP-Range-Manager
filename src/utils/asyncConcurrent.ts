/** 服务端/上游压力：单页最多同时发起的同源请求上限 */
export const DETECTION_MAX_CONCURRENCY = 24;

/**
 * 受控并发的异步 forEach（按索引更新结果时无需关心完成顺序）。
 * @param concurrency 同时执行的任务数量，至少为 1
 */
export async function forEachConcurrent<T>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<void>
): Promise<void> {
  if (items.length === 0) return;
  let pool = Math.floor(Number(concurrency));
  if (!Number.isFinite(pool) || pool < 1) pool = 1;
  pool = Math.min(DETECTION_MAX_CONCURRENCY, pool);

  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) break;
      await fn(items[i]!, i);
    }
  }

  const workers = Math.min(pool, items.length);
  await Promise.all(Array.from({ length: workers }, () => worker()));
}

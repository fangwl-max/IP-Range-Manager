import type { IPSegment, ProjectGroup, Supplier, UsageAreaOption } from '../types';
import {
  buildProjectGroupMasters,
  buildSupplierMasters,
  buildUsageAreaMasters,
  resolveMasterLabel,
  usageAreaMatchKey,
} from './displayNames';

/**
 * 将解析得到的地区/供应商/项目组与配置及现有 IP 段中的名称对齐，减少乱码与重复写法。
 */
export function normalizeBatchImportFields(
  row: Partial<IPSegment>,
  usageAreas: UsageAreaOption[],
  suppliers: Supplier[],
  projectGroups: ProjectGroup[],
  ipSegments: IPSegment[],
): Partial<IPSegment> {
  const um = buildUsageAreaMasters(usageAreas, ipSegments);
  const sm = buildSupplierMasters(suppliers, ipSegments);
  const pm = buildProjectGroupMasters(projectGroups, ipSegments);

  const usageRaw = String(row.usageArea ?? '').trim();
  const usageArea =
    !usageRaw || usageRaw === '未使用'
      ? '未使用'
      : resolveMasterLabel(usageRaw, um, usageAreaMatchKey) || usageRaw;

  const supRaw = String(row.supplier ?? '').trim();
  const supplier = supRaw ? resolveMasterLabel(supRaw, sm) || supRaw : '';

  let pgs = row.projectGroups;
  if (Array.isArray(pgs) && pgs.length > 0) {
    pgs = pgs.map((g) => {
      const g2 = String(g ?? '').trim();
      return g2 ? resolveMasterLabel(g2, pm) || g2 : g2;
    });
  }

  return { ...row, usageArea, supplier, projectGroups: pgs };
}

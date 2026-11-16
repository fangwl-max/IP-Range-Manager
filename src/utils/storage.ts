import { IPSegment, ProjectGroup, Supplier, UsageAreaOption, ASN, AsnGroup } from '../types';

const STORAGE_KEYS = {
  IP_SEGMENTS: 'ip_segments',
  PROJECT_GROUPS: 'project_groups',
  SUPPLIERS: 'suppliers',
  USAGE_AREAS: 'usage_areas',
  ASNS: 'asns',
  ASN_GROUPS: 'asn_groups',
} as const;

// 内存缓存：localStorage 可能因 5MB 配额限制写入失败，
// 内存缓存保证 getAll 始终返回最新完整数据
let _ipSegmentsCache: IPSegment[] | null = null;
let _projectGroupsCache: ProjectGroup[] | null = null;
let _suppliersCache: Supplier[] | null = null;
let _usageAreasCache: UsageAreaOption[] | null = null;
let _asnsCache: ASN[] | null = null;
let _asnGroupsCache: AsnGroup[] | null = null;

function readLS<T>(key: string): T[] | null {
  try {
    const data = localStorage.getItem(key);
    return data ? JSON.parse(data) : null;
  } catch { return null; }
}

function writeLS(key: string, value: unknown): void {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* 配额溢出静默跳过 */ }
}

// IP段存储
export const ipSegmentStorage = {
  getAll: (): IPSegment[] => {
    if (_ipSegmentsCache !== null) return _ipSegmentsCache;
    _ipSegmentsCache = readLS<IPSegment>(STORAGE_KEYS.IP_SEGMENTS) || [];
    return _ipSegmentsCache;
  },
  save: (segments: IPSegment[]): void => {
    _ipSegmentsCache = segments;
    writeLS(STORAGE_KEYS.IP_SEGMENTS, segments);
  },
  add: (segment: IPSegment): void => {
    const segments = ipSegmentStorage.getAll();
    segments.push(segment);
    ipSegmentStorage.save(segments);
  },
  update: (id: string, segment: Partial<IPSegment>): void => {
    const segments = ipSegmentStorage.getAll();
    const index = segments.findIndex(s => s.id === id);
    if (index !== -1) {
      segments[index] = { ...segments[index], ...segment, updatedAt: new Date().toISOString() };
      ipSegmentStorage.save(segments);
    }
  },
  delete: (id: string): void => {
    const segments = ipSegmentStorage.getAll();
    ipSegmentStorage.save(segments.filter(s => s.id !== id));
  },
};

/**
 * 以下「配置」存储（项目组、供应商、宣告地区、ASN）的新增应仅在配置管理页由用户手动操作；
 * 业务模块（如 IP 段导入）不得调用 add 写入配置项；确需批量替换整表时使用 save。
 */
// 项目组存储
export const projectGroupStorage = {
  getAll: (): ProjectGroup[] => {
    if (_projectGroupsCache !== null) return _projectGroupsCache;
    _projectGroupsCache = readLS<ProjectGroup>(STORAGE_KEYS.PROJECT_GROUPS) || [];
    return _projectGroupsCache;
  },
  save: (groups: ProjectGroup[]): void => {
    _projectGroupsCache = groups;
    writeLS(STORAGE_KEYS.PROJECT_GROUPS, groups);
  },
  add: (group: ProjectGroup): void => {
    const groups = projectGroupStorage.getAll();
    groups.push(group);
    projectGroupStorage.save(groups);
  },
  update: (id: string, group: Partial<ProjectGroup>): void => {
    const groups = projectGroupStorage.getAll();
    const index = groups.findIndex(g => g.id === id);
    if (index !== -1) {
      groups[index] = { ...groups[index], ...group };
      projectGroupStorage.save(groups);
    }
  },
  delete: (id: string): void => {
    const groups = projectGroupStorage.getAll();
    projectGroupStorage.save(groups.filter(g => g.id !== id));
  },
};

// 供应商存储
export const supplierStorage = {
  getAll: (): Supplier[] => {
    if (_suppliersCache !== null) return _suppliersCache;
    _suppliersCache = readLS<Supplier>(STORAGE_KEYS.SUPPLIERS) || [];
    return _suppliersCache;
  },
  save: (suppliers: Supplier[]): void => {
    _suppliersCache = suppliers;
    writeLS(STORAGE_KEYS.SUPPLIERS, suppliers);
  },
  add: (supplier: Supplier): void => {
    const suppliers = supplierStorage.getAll();
    suppliers.push(supplier);
    supplierStorage.save(suppliers);
  },
  update: (id: string, supplier: Partial<Supplier>): void => {
    const suppliers = supplierStorage.getAll();
    const index = suppliers.findIndex(s => s.id === id);
    if (index !== -1) {
      suppliers[index] = { ...suppliers[index], ...supplier };
      supplierStorage.save(suppliers);
    }
  },
  delete: (id: string): void => {
    const suppliers = supplierStorage.getAll();
    supplierStorage.save(suppliers.filter(s => s.id !== id));
  },
};

// 宣告地区选项存储
export const usageAreaStorage = {
  getAll: (): UsageAreaOption[] => {
    if (_usageAreasCache !== null) return _usageAreasCache;
    _usageAreasCache = readLS<UsageAreaOption>(STORAGE_KEYS.USAGE_AREAS) || [];
    return _usageAreasCache;
  },
  save: (areas: UsageAreaOption[]): void => {
    _usageAreasCache = areas;
    writeLS(STORAGE_KEYS.USAGE_AREAS, areas);
  },
  add: (area: UsageAreaOption): void => {
    const areas = usageAreaStorage.getAll();
    areas.push(area);
    usageAreaStorage.save(areas);
  },
  update: (id: string, area: Partial<UsageAreaOption>): void => {
    const areas = usageAreaStorage.getAll();
    const index = areas.findIndex(a => a.id === id);
    if (index !== -1) {
      areas[index] = { ...areas[index], ...area };
      usageAreaStorage.save(areas);
    }
  },
  delete: (id: string): void => {
    const areas = usageAreaStorage.getAll();
    usageAreaStorage.save(areas.filter(a => a.id !== id));
  },
};

// ASN 分组（仅配置页维护）
export const asnGroupStorage = {
  getAll: (): AsnGroup[] => {
    if (_asnGroupsCache !== null) return _asnGroupsCache;
    _asnGroupsCache = readLS<AsnGroup>(STORAGE_KEYS.ASN_GROUPS) || [];
    return _asnGroupsCache;
  },
  save: (groups: AsnGroup[]): void => {
    _asnGroupsCache = groups;
    writeLS(STORAGE_KEYS.ASN_GROUPS, groups);
  },
  add: (group: AsnGroup): void => {
    const groups = asnGroupStorage.getAll();
    groups.push(group);
    asnGroupStorage.save(groups);
  },
  update: (id: string, group: Partial<AsnGroup>): void => {
    const groups = asnGroupStorage.getAll();
    const index = groups.findIndex((g) => g.id === id);
    if (index !== -1) {
      groups[index] = { ...groups[index], ...group };
      asnGroupStorage.save(groups);
    }
  },
  delete: (id: string): void => {
    const groups = asnGroupStorage.getAll();
    asnGroupStorage.save(groups.filter((g) => g.id !== id));
  },
};

// ASN存储
export const asnStorage = {
  getAll: (): ASN[] => {
    if (_asnsCache !== null) return _asnsCache;
    _asnsCache = readLS<ASN>(STORAGE_KEYS.ASNS) || [];
    return _asnsCache;
  },
  save: (asns: ASN[]): void => {
    _asnsCache = asns;
    writeLS(STORAGE_KEYS.ASNS, asns);
  },
  add: (asn: ASN): void => {
    const asns = asnStorage.getAll();
    asns.push(asn);
    asnStorage.save(asns);
  },
  update: (id: string, asn: Partial<ASN>): void => {
    const asns = asnStorage.getAll();
    const index = asns.findIndex(a => a.id === id);
    if (index !== -1) {
      const merged: ASN = { ...asns[index], ...asn };
      if (Object.prototype.hasOwnProperty.call(asn, 'usageAreaIds')) {
        delete merged.usageAreaId;
        delete merged.usageAreaName;
      }
      if (Object.prototype.hasOwnProperty.call(asn, 'asnGroupId') && !asn.asnGroupId) {
        delete merged.asnGroupId;
      }
      if (Object.prototype.hasOwnProperty.call(asn, 'feeUsd') && (asn.feeUsd === undefined || asn.feeUsd === null)) {
        delete merged.feeUsd;
      }
      if (Object.prototype.hasOwnProperty.call(asn, 'expiryDate') && (!asn.expiryDate || !String(asn.expiryDate).trim())) {
        delete merged.expiryDate;
      }
      if (
        Object.prototype.hasOwnProperty.call(asn, 'purchaseDate') &&
        (!asn.purchaseDate || !String(asn.purchaseDate).trim())
      ) {
        delete merged.purchaseDate;
      }
      if (
        Object.prototype.hasOwnProperty.call(asn, 'usageHistory') &&
        (!asn.usageHistory || !Array.isArray(asn.usageHistory) || asn.usageHistory.length === 0)
      ) {
        delete merged.usageHistory;
      }
      if (
        Object.prototype.hasOwnProperty.call(asn, 'datacenter') &&
        (!asn.datacenter || !Array.isArray(asn.datacenter) || asn.datacenter.length === 0)
      ) {
        delete merged.datacenter;
      }
      const legacy = merged as unknown as { supplierNames?: unknown };
      delete legacy.supplierNames;
      asns[index] = merged;
      asnStorage.save(asns);
    }
  },
  delete: (id: string): void => {
    const asns = asnStorage.getAll();
    asnStorage.save(asns.filter(a => a.id !== id));
  },
};

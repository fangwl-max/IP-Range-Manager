export interface PermNode {
  label: string;
  adminOnly?: boolean;
  features?: Record<string, string>;
}

export const PAGE_PERMS: Record<string, PermNode> = {
  'ip-management': {
    label: 'IP段管理',
    features: {
      'edit': '新增 / 编辑 IP段',
      'delete': '删除 IP段',
      'import': '批量导入 / 文本批量编辑',
      'export': '导出表格',
    },
  },
  'irr-detection': {
    label: '综合检测',
    features: {
      'ssh-manage': '管理 SSH 服务器',
    },
  },
  'pre-purchase-check': { label: '购前检测' },
  'cost-analysis-main': { label: '费用分析' },
  'cost-analysis-ipxo': { label: 'IPXO 账单' },
  'ip-segment-stats': { label: 'IP 段统计' },
  'config-project-groups': {
    label: '项目组配置',
    features: { 'edit': '新增 / 编辑 / 删除' },
  },
  'config-suppliers': {
    label: '供应商配置',
    features: { 'edit': '新增 / 编辑 / 删除' },
  },
  'config-usage-areas': {
    label: '宣告地区配置',
    features: { 'edit': '新增 / 编辑 / 删除' },
  },
  'asn-management': {
    label: 'ASN 管理',
    features: { 'edit': '新增 / 编辑 / 删除' },
  },
  'asn-standby-a': {
    label: 'A 组备用 AS',
    features: { 'edit': '新增 / 编辑 / 删除' },
  },
  'asn-standby-b': {
    label: 'B 组备用 AS',
    features: { 'edit': '新增 / 编辑 / 删除' },
  },
  'notify-config': {
    label: '通知配置',
    features: { 'edit': '编辑配置' },
  },
  'announce-zen': {
    label: 'Zenlayer IP段宣告',
    features: {
      'announce': '执行宣告（ZEC / VOB）',
      'withdraw': '取消宣告 / 删除弹性IP',
    },
  },
  'announce-capital-online': {
    label: '首都在线 IP段宣告',
    features: {
      'announce': '执行批量宣告',
      'withdraw': '执行批量撤播',
    },
  },
  'remote-sync': { label: '远程数据同步', adminOnly: true },
  'user-management': { label: '用户与权限', adminOnly: true },
};

const ALL_KEYS: string[] = Object.entries(PAGE_PERMS).flatMap(([pageKey, node]) => [
  pageKey,
  ...Object.keys(node.features ?? {}).map(fk => `${pageKey}.${fk}`),
]);

export const ROLE_DEFAULTS: Record<string, string[]> = {
  admin: ALL_KEYS,
  editor: [
    'ip-management', 'ip-management.edit', 'ip-management.delete', 'ip-management.import', 'ip-management.export',
    'irr-detection',
    'pre-purchase-check',
    'cost-analysis-main', 'cost-analysis-ipxo', 'ip-segment-stats',
    'config-project-groups', 'config-project-groups.edit',
    'config-suppliers', 'config-suppliers.edit',
    'config-usage-areas', 'config-usage-areas.edit',
    'asn-management', 'asn-management.edit',
    'asn-standby-a', 'asn-standby-a.edit',
    'asn-standby-b', 'asn-standby-b.edit',
    'notify-config', 'notify-config.edit',
    'announce-zen', 'announce-zen.announce', 'announce-zen.withdraw',
    'announce-capital-online', 'announce-capital-online.announce', 'announce-capital-online.withdraw',
  ],
  viewer: [
    'ip-management',
    'irr-detection',
    'cost-analysis-main', 'cost-analysis-ipxo', 'ip-segment-stats',
  ],
};

export interface PermTreeNode {
  title: string;
  key: string;
  disabled?: boolean;
  children?: PermTreeNode[];
}

export function buildPermTree(): PermTreeNode[] {
  return Object.entries(PAGE_PERMS).map(([pageKey, node]) => ({
    title: node.label + (node.adminOnly ? '（仅管理员）' : ''),
    key: pageKey,
    disabled: node.adminOnly,
    children: node.features
      ? Object.entries(node.features).map(([fk, flabel]) => ({
          title: flabel,
          key: `${pageKey}.${fk}`,
          disabled: node.adminOnly,
        }))
      : undefined,
  }));
}

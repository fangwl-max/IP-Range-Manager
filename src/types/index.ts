// IP段被墙国家类型
export type BlockedCountry = 'iran' | 'myanmar' | 'turkmenistan' | 'russia';

// 续费状态类型
export type RenewalStatus = 'not_renewed' | 'renewed' | 'cancelled' | 'refunded';

// IP段使用历程记录接口
export interface IPSegmentHistory {
  id: string; // 历程记录ID
  projectGroup: string; // 项目组名称
  startDate: string; // 开始日期（YYYY-MM-DD）
  endDate?: string; // 结束日期（YYYY-MM-DD），如果为空表示当前仍在使用
  createdAt: string; // 创建时间
  updatedAt: string; // 更新时间
}

// IP段信息接口
export interface IPSegment {
  id: string;
  segment: string; // IP段，例如：192.168.1.0/24
  supplier: string; // IP段供应商
  asn: string; // ASN号码（列表主显：BGP 生效的 ASN；其余见 additionalAsns）
  /**
   * 主显 ASN 是否当前在 BGP 宣告（路由一致性检测同步时写入）。
   * false：灰色 Tag，表示仅注册/检测值、BGP 未宣告；未设置则按旧数据兼容为「生效」样式。
   */
  primaryAsnInBgp?: boolean;
  /** 同前缀下其它 ASN（由路由检测同步；主列表仅点开后查看） */
  additionalAsns?: string[];
  usageArea: string; // 使用地区
  purchaseDate: string; // 购买时间（YYYY-MM-DD）
  renewalDate: string; // 续费时间（YYYY-MM-DD）
  cancellationDate: string; // 取消时间（YYYY-MM-DD）
  monthlyPrice: number; // 价格/月（$）
  renewalStatus: RenewalStatus; // 是否续费
  projectGroups: string[]; // 使用的项目组列表（当前使用的项目组，用于兼容旧数据）
  serverLocations: ServerLocation[]; // 服务器位置列表
  blockedCountries: BlockedCountry[]; // 被墙国家列表
  rateLimitedCountries?: BlockedCountry[]; // 限速国家列表
  detectedCountries?: BlockedCountry[]; // 已检测的国家列表（用于区分"未检测"和"可用"）
  history?: IPSegmentHistory[]; // 使用历程记录（按时间顺序）
  /** 人工标记：多次购买同一 IP 段；费用统计以 purchaseDate（最近一期购买日）为计费起点，并结合历程拆分项目组 */
  multiPurchaseMarked?: boolean;
  /** 早于当前 purchaseDate 的历次购买日（YYYY-MM-DD），用于列表悬浮提示，不参与自动续费日推算 */
  previousPurchaseDates?: string[];
  /** 数据来源标记：'ipxo_api' 表示由 IPXO API 同步写入，未设置表示手动录入 */
  syncSource?: 'ipxo_api' | 'manual';
  /** IPXO API 同步时对应的 market_service UUID，用于后续增量同步比对 */
  ipxoServiceUuid?: string;
  /** 最近一次从 IPXO API 同步的时间（ISO 字符串） */
  ipxoLastSyncAt?: string;
  /** 备注信息（可选） */
  remark?: string;
  createdAt: string; // 创建时间
  updatedAt: string; // 更新时间
}

// 续费状态选项（用于表单选择）
export const RENEWAL_STATUS_OPTIONS = [
  { label: '无', value: 'not_renewed', color: 'default' },
  { label: '取消续费', value: 'cancelled', color: 'orange' },
  { label: '已退款', value: 'refunded', color: 'blue' },
] as const;

// 续费状态表格显示配置（文本 + 背景色）
export const RENEWAL_STATUS_DISPLAY: Record<RenewalStatus, { text: string; bgColor: string }> = {
  not_renewed: { text: '', bgColor: 'transparent' },
  renewed: { text: '已续费', bgColor: '#d9f7be' },
  cancelled: { text: '取消续费', bgColor: '#ffd591' },
  refunded: { text: '已退款', bgColor: '#bae7ff' },
};

// 服务器位置接口
export interface ServerLocation {
  supplier: string; // 供应商
  region: string; // 地区
}

// 项目组接口
export interface ProjectGroup {
  id: string;
  name: string;
}

// 供应商接口
export interface Supplier {
  id: string;
  name: string;
}

/** ASN 业务状态 */
export type AsnStatus = 'unused' | 'in_use' | 'cancelled';

export const ASN_STATUS_OPTIONS: { label: string; value: AsnStatus; color: string }[] = [
  { label: '未使用', value: 'unused', color: 'default' },
  { label: '使用中', value: 'in_use', color: 'processing' },
  { label: '已取消', value: 'cancelled', color: 'error' },
];

/** ASN 逻辑分组：多个 ASN 可挂同一组；在存储中的数组顺序即为展示与下拉框顺序（可手动调整） */
export interface AsnGroup {
  id: string;
  name: string;
}

/** ASN 在某一被墙国家维度的启用/被墙时间 */
export interface AsnCountryUsageEntry {
  /** 在该国「启用/可用」的日期 */
  enabledAt?: string; // YYYY-MM-DD
  /** 在该国被墙/封堵的日期 */
  blockedAt?: string; // YYYY-MM-DD
}

/** ASN 使用历程（备案）；费用是否计入以「月费 + 状态 + 到期日」为准 */
export interface AsnUsageHistoryEntry {
  id: string;
  /** 开始日 YYYY-MM-DD */
  startDate: string;
  /** 结束日（含当天仍在该段内）；不设表示「至今」 */
  endDate?: string;
  remark?: string;
}

// ASN接口
export interface ASN {
  id: string;
  name: string; // ASN号码，例如：AS12345
  /** 业务状态：未使用 / 使用中 / 已取消（旧数据未写时按「未使用」） */
  status?: AsnStatus;
  /** 所属 ASN 分组（id 与「配置 → ASN 分组」中维护的一致，可选；未设表示未分组） */
  asnGroupId?: string;
  /** 关联使用地区（可多选，ID 与「使用地区」配置一致） */
  usageAreaIds?: string[];
  /**
   * 四国分栏，键与名称对应：`iran` 伊朗 · `myanmar` 缅甸 · `turkmenistan` 土库曼 · `russia` 俄罗斯
   * 每国各一条记录，可分别填写「启用时间」「被墙时间」（YYYY-MM-DD，可选）
   */
  countryUsage?: Partial<Record<BlockedCountry, AsnCountryUsageEntry>>;
  /** 在哪些项目组下使用该 ASN，可多选，名称与「项目组」配置一致 */
  projectGroupNames?: string[];
  /**
   * 月度费用（美元 USD），可选。
   * 仅在「未取消」且「未到到期日（含当日仍计）」且填写了月费时纳入列表页「月度费用合计」。
   */
  feeUsd?: number;
  /** 到期日 YYYY-MM-DD（不含续费则填在此日之后不再计入月度费用合计；当日仍计入） */
  expiryDate?: string;
  /** 购买日 YYYY-MM-DD（可选；用于「过往月份」按月汇总时确定从哪个月开始计费） */
  purchaseDate?: string;
  /** 使用历程（备案）；不影响合计公式，可与到期日配合查阅 */
  usageHistory?: AsnUsageHistoryEntry[];
  /**
   * 配置地区（机房所在运营商/地区，例如：ZEN、首都在线、自建机房、Liasail）
   * 可多选，支持自由输入新值
   */
  datacenter?: string[];
  /**
   * 旧版单选使用地区，仅用于兼容已存数据；保存时应写入 usageAreaIds
   * @deprecated
   */
  usageAreaId?: string;
  usageAreaName?: string;
}

// 使用地区选项接口
export interface UsageAreaOption {
  id: string;
  name: string;
  color: string; // 颜色值，如 '#1890ff'
}

// 被墙国家选项
export const BLOCKED_COUNTRY_OPTIONS = [
  { label: '伊朗', value: 'iran' },
  { label: '缅甸', value: 'myanmar' },
  { label: '土库曼', value: 'turkmenistan' },
  { label: '俄罗斯', value: 'russia' },
] as const;

// 预设颜色选项
export const PRESET_COLORS = [
  '#1890ff', '#52c41a', '#faad14', '#f5222d', '#722ed1',
  '#13c2c2', '#eb2f96', '#fa8c16', '#2f54eb', '#a0d911',
  '#1890ff', '#52c41a', '#faad14', '#f5222d', '#722ed1',
] as const;

// 预设使用地区选项（根据图片中的配置）
export const DEFAULT_USAGE_AREA_OPTIONS: UsageAreaOption[] = [
  { id: 'zen-dallas', name: 'ZEN达拉斯', color: '#91D5FF' }, // 浅蓝色
  { id: 'zen-washington', name: 'ZEN华盛顿', color: '#FFFACD' }, // 浅黄色/米色
  { id: 'zen-frankfurt', name: 'ZEN法兰克福', color: '#A0522D' }, // 棕色
  { id: 'zet', name: 'ZET', color: '#E6D3FF' }, // 浅紫色
  { id: 'unused', name: '未使用', color: '#FFC0CB' }, // 浅粉色
  { id: 'zen-miami', name: 'ZEN迈阿密', color: '#13C2C2' }, // 浅青色/青色
  { id: 'fdc-germany', name: 'FDC德国', color: '#2F54EB' }, // 深蓝色
  { id: 'zen-los-angeles', name: 'ZEN洛杉矶', color: '#52C41A' }, // 浅绿色
  { id: 'zen-helsinki', name: 'ZEN赫尔辛基', color: '#389E0D' }, // 深绿色
  { id: 'ows', name: 'OWS', color: '#FA8C16' }, // 橙色
  { id: 'zen-singapore', name: 'ZEN新加坡', color: '#1890FF' }, // 中蓝色
  { id: 'capital-online', name: '首都在线', color: '#722ED1' }, // 紫色
  { id: 'mobile-international', name: '移动国际', color: '#40A9FF' }, // 亮蓝色
];


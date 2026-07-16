import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  Card,
  Table,
  Button,
  Space,
  Typography,
  Tag,
  Modal,
  Select,
  message,
  Popconfirm,
  Empty,
  Tooltip,
  Divider,
  Input,
  Collapse,
  Checkbox,
  DatePicker,
  Form,
  Tabs,
  Alert,
  Badge,
  Radio,
} from 'antd';
import {
  PlusOutlined,
  DeleteOutlined,
  StarOutlined,
  ReloadOutlined,
  EditOutlined,
  LockOutlined,
  CheckCircleOutlined,
  MinusCircleOutlined,
  SafetyCertificateOutlined,
  DownloadOutlined,
  CopyOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import * as XLSX from 'xlsx';
import { IPSegment, RENEWAL_STATUS_DISPLAY, BLOCKED_COUNTRY_OPTIONS } from '../types';
import { useAuth } from '../contexts/AuthContext';

const { Title, Text } = Typography;
const { Panel } = Collapse;

// ─── 数据结构 ──────────────────────────────────────────────────────────────────

interface BlockedInfo {
  countries: string[];          // 被墙国家（使用 BlockedCountry 枚举值）
  availableCountries?: string[]; // 可用国家（例如：俄罗斯可用）
  blockedAt?: string;           // 被墙时间 YYYY-MM-DD
  note?: string;                // 被墙备注
}

type UsageStatus = 'available' | 'used';
type AnnouncementStatus = 'not_announced' | 'announced' | 'cancelled';

const ANNOUNCEMENT_STATUS_OPTIONS: { label: string; value: AnnouncementStatus; color: string }[] = [
  { label: '未宣告', value: 'not_announced', color: 'default' },
  { label: '宣告完成', value: 'announced', color: 'green' },
  { label: '已取消宣告', value: 'cancelled', color: 'orange' },
];

interface AsnStandbyItem {
  segment: string;
  remark?: string;
  addedAt: string;
  blockedInfo?: BlockedInfo;
  availableStandby?: boolean;
  availableAddedAt?: string;
  usageStatus?: UsageStatus;
  usedAt?: string;
  announcementStatus?: AnnouncementStatus; // 宣告状态
}

interface AsnStandbyData {
  A: { items: AsnStandbyItem[]; groupMeta?: Record<string, { remark?: string; order?: number }> };
  B: { items: AsnStandbyItem[]; groupMeta?: Record<string, { remark?: string; order?: number }> };
}

interface Props {
  group: 'A' | 'B';
}

// ─── 常量 ────────────────────────────────────────────────────────────────────

const GROUP_LABEL: Record<string, string> = {
  A: 'A 组备用 AS',
  B: 'B 组备用 AS',
};

const GROUP_COLOR: Record<string, string> = {
  A: 'blue',
  B: 'purple',
};

const COUNTRY_LABEL: Record<string, string> = {
  iran: '伊朗',
  myanmar: '缅甸',
  turkmenistan: '土库曼',
  russia: '俄罗斯',
};

const COUNTRY_TAG_COLOR: Record<string, string> = {
  iran: 'red',
  myanmar: 'orange',
  turkmenistan: 'gold',
  russia: 'magenta',
};

// ─── 辅助函数 ─────────────────────────────────────────────────────────────────

/** 按 ASN 对 AsnStandbyItem 数组分组，返回排序后的 ASN 组数组 */
function groupByAsn(
  items: AsnStandbyItem[],
  getSegInfo: (seg: string) => IPSegment | undefined,
  meta?: Record<string, { remark?: string; order?: number }>
): Array<{ asn: string; items: AsnStandbyItem[] }> {
  const map = new Map<string, AsnStandbyItem[]>();
  for (const item of items) {
    const seg = getSegInfo(item.segment);
    const key = seg?.asn || '(未设置 ASN)';
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(item);
  }
  // 有 ASN 的组在前，无 ASN 的在最后
  const sorted: Array<{ asn: string; items: AsnStandbyItem[] }> = [];
  for (const [asn, grpItems] of map.entries()) {
    if (asn !== '(未设置 ASN)') sorted.push({ asn, items: grpItems });
  }
  // 优先按 meta.order 排序，其次按 ASN 字母序
  sorted.sort((a, b) => {
    const oa = meta?.[a.asn]?.order ?? Infinity;
    const ob = meta?.[b.asn]?.order ?? Infinity;
    if (oa !== ob) return oa - ob;
    return a.asn.localeCompare(b.asn);
  });
  if (map.has('(未设置 ASN)')) {
    sorted.push({ asn: '(未设置 ASN)', items: map.get('(未设置 ASN)')! });
  }
  return sorted;
}

// ─── 主组件 ──────────────────────────────────────────────────────────────────

const AsnStandbyPage: React.FC<Props> = ({ group }) => {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const [items, setItems] = useState<AsnStandbyItem[]>([]);
  const [allSegments, setAllSegments] = useState<IPSegment[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  // 分组元数据（备注和排序），key 为 ASN 字符串
  const [groupMeta, setGroupMeta] = useState<Record<string, { remark?: string; order?: number }>>({});
  // 分组备注编辑状态
  const [editingGroupAsn, setEditingGroupAsn] = useState<string | null>(null);
  const [editingGroupRemark, setEditingGroupRemark] = useState('');

  // 添加 IP 段弹窗
  const [addModalVisible, setAddModalVisible] = useState(false);
  const [selectedToAdd, setSelectedToAdd] = useState<string[]>([]);
  const [searchText, setSearchText] = useState('');
  const [addMode, setAddMode] = useState<'select' | 'batch'>('select');
  const [batchInputText, setBatchInputText] = useState('');

  // 编辑被墙信息弹窗
  const [blockedModalVisible, setBlockedModalVisible] = useState(false);
  const [editingSegment, setEditingSegment] = useState<string | null>(null);
  const [blockedForm] = Form.useForm();

  // Tab 状态
  const [activeTab, setActiveTab] = useState<'list' | 'available' | 'used'>('list');

  // 批量编辑使用状态
  const [selectedAvailableKeys, setSelectedAvailableKeys] = useState<string[]>([]);
  // 批量编辑列表 Tab
  const [selectedListKeys, setSelectedListKeys] = useState<string[]>([]);

  // 批量编辑备注弹窗
  const [batchRemarkModalVisible, setBatchRemarkModalVisible] = useState(false);
  const [batchRemarkValue, setBatchRemarkValue] = useState('');
  // 批量编辑被墙信息弹窗
  const [batchBlockedModalVisible, setBatchBlockedModalVisible] = useState(false);
  const [batchBlockedForm] = Form.useForm();
  // 批量编辑宣告状态
  const [batchAnnouncementModalVisible, setBatchAnnouncementModalVisible] = useState(false);
  // 批量编辑整合弹窗
  const [batchEditModalVisible, setBatchEditModalVisible] = useState(false);

  // 检测可用 Tab：批量转移到IP段列表（IP段管理页）
  const [batchTransferModalVisible, setBatchTransferModalVisible] = useState(false);
  const [batchTransferring, setBatchTransferring] = useState(false);

  // 检测可用备用 - 密码解锁
  const [unlocked, setUnlocked] = useState(false);
  const [authTargetTab, setAuthTargetTab] = useState<'available' | 'used'>('available');
  const [authModalVisible, setAuthModalVisible] = useState(false);
  const [authUsername, setAuthUsername] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [authLoading, setAuthLoading] = useState(false);
  const [authError, setAuthError] = useState('');

  // 分组级「申请使用」解锁状态（key: asn，value: 已解锁）
  const [unlockedGroups, setUnlockedGroups] = useState<Set<string>>(new Set());
  const [groupApplyModalVisible, setGroupApplyModalVisible] = useState(false);
  const [applyTargetAsn, setApplyTargetAsn] = useState('');
  const [applyPassword, setApplyPassword] = useState('');
  const [applyLoading, setApplyLoading] = useState(false);
  const [applyError, setApplyError] = useState('');

  // group 切换时重置解锁状态（admin 始终保持解锁）
  const prevGroupRef = useRef(group);
  useEffect(() => {
    if (prevGroupRef.current !== group) {
      if (!isAdmin) setUnlocked(false);
      setActiveTab('list');
      setSelectedAvailableKeys([]);
      setSelectedListKeys([]);
      setUnlockedGroups(new Set());
      prevGroupRef.current = group;
    }
  }, [group, isAdmin]);

  // admin 始终自动解锁
  useEffect(() => {
    if (isAdmin) setUnlocked(true);
  }, [isAdmin]);

  // ── 数据加载 ──────────────────────────────────────────────────────────────

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [standbyRes, segRes] = await Promise.all([
        fetch('/api/asn-standby-groups'),
        fetch('/api/get-data'),
      ]);
      const standbyJson = await standbyRes.json();
      const segJson = await segRes.json();

      if (standbyJson.success) {
        const data: AsnStandbyData = standbyJson.data || { A: { items: [] }, B: { items: [] } };
        setItems(data[group]?.items || []);
        setGroupMeta(data[group]?.groupMeta || {});
      }
      if (segJson.ipSegments) {
        setAllSegments(segJson.ipSegments);
      }
    } catch (e: any) {
      message.error('加载失败: ' + e.message);
    } finally {
      setLoading(false);
    }
  }, [group]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // ── 数据保存 ──────────────────────────────────────────────────────────────

  const saveData = async (newItems: AsnStandbyItem[], newGroupMeta?: Record<string, { remark?: string; order?: number }>) => {
    setSaving(true);
    try {
      const res = await fetch('/api/asn-standby-groups');
      const json = await res.json();
      const current: AsnStandbyData = json.success
        ? (json.data || { A: { items: [] }, B: { items: [] } })
        : { A: { items: [] }, B: { items: [] } };
      const meta = newGroupMeta !== undefined ? newGroupMeta : groupMeta;
      current[group] = { items: newItems, groupMeta: meta };

      const saveRes = await fetch('/api/asn-standby-groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(current),
      });
      const saveJson = await saveRes.json();
      if (saveJson.success) {
        setItems(newItems);
        if (newGroupMeta !== undefined) setGroupMeta(newGroupMeta);
        message.success('已保存');
      } else {
        message.error('保存失败: ' + saveJson.message);
      }
    } catch (e: any) {
      message.error('保存失败: ' + e.message);
    } finally {
      setSaving(false);
    }
  };

  // ── 辅助 ──────────────────────────────────────────────────────────────────

  const addedSegments = new Set(items.map(i => i.segment));

  const getSegInfo = (segment: string): IPSegment | undefined =>
    allSegments.find(s => s.segment === segment);

  // ── 分组排序和备注 ────────────────────────────────────────────────────────

  /** 保存分组元数据（备注/排序），不改动 items */
  const saveGroupMeta = async (newMeta: Record<string, { remark?: string; order?: number }>) => {
    await saveData(items, newMeta);
  };

  /** 上移/下移某个 ASN 分组 */
  const handleMoveGroup = async (asn: string, direction: 'up' | 'down', allAsns: string[]) => {
    const idx = allAsns.indexOf(asn);
    if (idx < 0) return;
    const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
    if (swapIdx < 0 || swapIdx >= allAsns.length) return;
    const newMeta = { ...groupMeta };
    // 交换两个 ASN 的 order
    const orderA = newMeta[asn]?.order ?? idx;
    const orderB = newMeta[allAsns[swapIdx]]?.order ?? swapIdx;
    newMeta[asn] = { ...(newMeta[asn] || {}), order: orderB };
    newMeta[allAsns[swapIdx]] = { ...(newMeta[allAsns[swapIdx]] || {}), order: orderA };
    await saveGroupMeta(newMeta);
  };

  /** 保存分组备注 */
  const handleSaveGroupRemark = async (asn: string, remark: string) => {
    const newMeta = { ...groupMeta, [asn]: { ...(groupMeta[asn] || {}), remark } };
    await saveGroupMeta(newMeta);
    setEditingGroupAsn(null);
  };

  // ── 批量添加 ──────────────────────────────────────────────────────────────

  const availableSegments = allSegments.filter(s =>
    !addedSegments.has(s.segment) &&
    (searchText === '' ||
      s.segment.includes(searchText) ||
      (s.remark || '').includes(searchText) ||
      (s.asn || '').toLowerCase().includes(searchText.toLowerCase()))
  );

  /** 按 ASN 分组可选 IP 段，生成 Select optionGroupLabel 格式 */
  const groupedAvailableOptions = (() => {
    const map = new Map<string, IPSegment[]>();
    for (const seg of availableSegments) {
      const key = seg.asn || '(无 ASN)';
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(seg);
    }
    const result: { label: string; options: { label: string; value: string }[] }[] = [];
    // 有 ASN 的组先渲染
    for (const [asn, segs] of map.entries()) {
      if (asn !== '(无 ASN)') {
        result.push({
          label: asn,
          options: segs.map(s => ({
            label: `${s.segment}${s.remark ? `  · ${s.remark}` : ''}`,
            value: s.segment,
          })),
        });
      }
    }
    result.sort((a, b) => a.label.localeCompare(b.label));
    if (map.has('(无 ASN)')) {
      result.push({
        label: '(无 ASN)',
        options: map.get('(无 ASN)')!.map(s => ({
          label: `${s.segment}${s.remark ? `  · ${s.remark}` : ''}`,
          value: s.segment,
        })),
      });
    }
    return result;
  })();

  const handleAdd = async () => {
    if (addMode === 'select') {
      if (selectedToAdd.length === 0) {
        message.warning('请至少选择一个 IP 段');
        return;
      }
      const nowIso = new Date().toISOString();
      const newItems: AsnStandbyItem[] = [
        ...items,
        ...selectedToAdd.map(seg => ({
          segment: seg,
          addedAt: nowIso,
        })),
      ];
      await saveData(newItems);
      setSelectedToAdd([]);
      setSearchText('');
      setAddModalVisible(false);
    } else {
      // 批量输入模式：解析文本框，每行一个 IP 段
      const lines = batchInputText.split(/[\n,，\s]+/).map(s => s.trim()).filter(Boolean);
      // 基本校验：含 / 的才算 CIDR
      const valid = lines.filter(s => /^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/.test(s));
      const invalid = lines.filter(s => !/^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/.test(s));
      if (valid.length === 0) {
        message.warning('未识别到有效的 IP 段（格式：x.x.x.x/xx）');
        return;
      }
      const addedSet = new Set(items.map(i => i.segment));
      const toAdd = valid.filter(s => !addedSet.has(s));
      const skipped = valid.length - toAdd.length;
      if (toAdd.length === 0) {
        message.warning(`所有 IP 段已存在于本组（${skipped} 个）`);
        return;
      }
      const nowIso = new Date().toISOString();
      const newItems: AsnStandbyItem[] = [
        ...items,
        ...toAdd.map(seg => ({ segment: seg, addedAt: nowIso })),
      ];
      await saveData(newItems);
      setBatchInputText('');
      setAddModalVisible(false);
      const msgs: string[] = [`已添加 ${toAdd.length} 个 IP 段`];
      if (skipped > 0) msgs.push(`${skipped} 个已存在跳过`);
      if (invalid.length > 0) msgs.push(`${invalid.length} 行格式无效跳过`);
      message.success(msgs.join('，'));
    }
  };

  // ── 移除 IP 段 ────────────────────────────────────────────────────────────

  const handleRemove = async (segment: string) => {
    const newItems = items.filter(i => i.segment !== segment);
    await saveData(newItems);
  };

  // ── 编辑被墙信息 ──────────────────────────────────────────────────────────

  const openBlockedModal = (segment: string) => {
    const item = items.find(i => i.segment === segment);
    setEditingSegment(segment);
    blockedForm.setFieldsValue({
      countries: item?.blockedInfo?.countries || [],
      availableCountries: item?.blockedInfo?.availableCountries || [],
      blockedAt: item?.blockedInfo?.blockedAt ? dayjs(item.blockedInfo.blockedAt) : null,
      note: item?.blockedInfo?.note || '',
      remark: item?.remark || '',
    });
    setBlockedModalVisible(true);
  };

  const handleBlockedSave = async () => {
    const values = await blockedForm.validateFields();
    const newItems = items.map(i => {
      if (i.segment !== editingSegment) return i;
      return {
        ...i,
        remark: values.remark || undefined,
        blockedInfo: {
          countries: values.countries || [],
          availableCountries: values.availableCountries || [],
          blockedAt: values.blockedAt ? (values.blockedAt as dayjs.Dayjs).format('YYYY-MM-DD') : undefined,
          note: values.note || undefined,
        } as BlockedInfo,
      };
    });
    await saveData(newItems);
    setBlockedModalVisible(false);
    setEditingSegment(null);
  };

  // ── 收录 / 取消收录 ───────────────────────────────────────────────────────

  /** 判断一条 IP 段是否满足收录条件：被墙信息中必须包含「俄罗斯可用」 */
  const canCollect = (item: AsnStandbyItem): boolean => {
    return (item.blockedInfo?.availableCountries || []).includes('russia');
  };

  const handleToggleAvailable = async (segment: string, toAvailable: boolean) => {
    if (toAvailable) {
      const item = items.find(i => i.segment === segment);
      if (!item || !canCollect(item)) {
        message.warning('收录条件不满足：被墙信息中需包含「俄罗斯可用」后才能收录');
        return;
      }
    }
    const newItems = items.map(i => {
      if (i.segment !== segment) return i;
      return {
        ...i,
        availableStandby: toAvailable,
        availableAddedAt: toAvailable ? new Date().toISOString() : undefined,
        // 取消收录时同步重置 usageStatus
        usageStatus: toAvailable ? (i.usageStatus || 'available') : undefined,
        usedAt: toAvailable ? i.usedAt : undefined,
      };
    });
    await saveData(newItems);
  };

  // ── 标记为已使用（启用）────────────────────────────────────────────────────

  const handleMarkAsUsed = async (segment: string) => {
    const newItems = items.map(i => {
      if (i.segment !== segment) return i;
      return { ...i, usageStatus: 'used' as UsageStatus, usedAt: new Date().toISOString() };
    });
    await saveData(newItems);
    setSelectedAvailableKeys(prev => prev.filter(k => k !== segment));
  };

  // ── 批量操作（IP段列表 Tab）───────────────────────────────────────────────

  /** 批量收录：仅处理满足 canCollect 条件的选中项 */
  const handleBatchCollect = async () => {
    const eligible = selectedListKeys.filter(seg => {
      const item = items.find(i => i.segment === seg);
      return item && canCollect(item);
    });
    if (eligible.length === 0) {
      message.warning('所选 IP 段均不满足收录条件（需先在被墙信息中标记「俄罗斯可用」）');
      return;
    }
    const nowIso = new Date().toISOString();
    const newItems = items.map(i => {
      if (!eligible.includes(i.segment)) return i;
      return {
        ...i,
        availableStandby: true,
        availableAddedAt: i.availableAddedAt || nowIso,
        usageStatus: (i.usageStatus || 'available') as UsageStatus,
      };
    });
    await saveData(newItems);
    if (eligible.length < selectedListKeys.length) {
      message.info(`已收录 ${eligible.length} 个（${selectedListKeys.length - eligible.length} 个不满足条件已跳过）`);
    }
    setSelectedListKeys([]);
  };

  /** 批量移除：将选中项从当前组彻底移除 */
  const handleBatchRemove = async () => {
    const newItems = items.filter(i => !selectedListKeys.includes(i.segment));
    await saveData(newItems);
    setSelectedListKeys([]);
  };

  /** 批量编辑备注 */
  const handleBatchEditRemark = async () => {
    const newItems = items.map(i => {
      if (!selectedListKeys.includes(i.segment)) return i;
      return { ...i, remark: batchRemarkValue };
    });
    await saveData(newItems);
    setBatchRemarkModalVisible(false);
    setBatchRemarkValue('');
    setSelectedListKeys([]);
  };

  /** 批量编辑被墙信息 */
  const handleBatchEditBlocked = async () => {
    const values = await batchBlockedForm.validateFields().catch(() => null);
    if (!values) return;
    const newItems = items.map(i => {
      if (!selectedListKeys.includes(i.segment)) return i;
      return {
        ...i,
        blockedInfo: {
          countries: values.countries || [],
          availableCountries: values.availableCountries || [],
          blockedAt: values.blockedAt ? (values.blockedAt as any).format('YYYY-MM-DD') : undefined,
          note: values.note || undefined,
        } as BlockedInfo,
      };
    });
    await saveData(newItems);
    setBatchBlockedModalVisible(false);
    batchBlockedForm.resetFields();
    setSelectedListKeys([]);
  };

  // ── 批量设置使用状态 ──────────────────────────────────────────────────────

  /** 批量设置宣告状态（列表 Tab） */
  const handleBatchSetAnnouncement = async (status: AnnouncementStatus) => {
    const newItems = items.map(i => {
      if (!selectedListKeys.includes(i.segment)) return i;
      return { ...i, announcementStatus: status };
    });
    await saveData(newItems);
    setBatchAnnouncementModalVisible(false);
  };

  /** 单行设置宣告状态 */
  const handleSetAnnouncement = async (segment: string, status: AnnouncementStatus) => {
    const newItems = items.map(i =>
      i.segment === segment ? { ...i, announcementStatus: status } : i
    );
    await saveData(newItems);
  };


  const handleBatchSetUsageStatus = async (status: UsageStatus) => {
    const newItems = items.map(i => {
      if (!selectedAvailableKeys.includes(i.segment)) return i;
      return {
        ...i,
        usageStatus: status,
        usedAt: status === 'used' ? nowIso : i.usedAt,
      };
    });
    await saveData(newItems);
    setSelectedAvailableKeys([]);
  };

  // ── 检测可用 Tab：批量转移到 IP 段管理 ───────────────────────────────────

  const handleBatchTransferToIPManagement = async () => {
    setBatchTransferring(true);
    try {
      // 将选中的 IP 段从「检测可用」移回「IP段列表」（取消收录）
      const newItems = items.map(i => {
        if (!selectedAvailableKeys.includes(i.segment)) return i;
        return {
          ...i,
          availableStandby: false,
          availableAddedAt: undefined,
          usageStatus: undefined,
          usedAt: undefined,
        };
      });
      await saveData(newItems);
      message.success(`已将 ${selectedAvailableKeys.length} 个 IP 段移回 IP 段列表`);
      setBatchTransferModalVisible(false);
      setSelectedAvailableKeys([]);
    } catch (e: any) {
      message.error('操作失败: ' + e.message);
    } finally {
      setBatchTransferring(false);
    }
  };

  const handleTabChange = (key: string) => {
    const needsAuth = (key === 'available' || key === 'used') && !unlocked;
    if (needsAuth) {
      if (isAdmin) {
        setUnlocked(true);
        setActiveTab(key as 'list' | 'available' | 'used');
        return;
      }
      setAuthTargetTab(key as 'available' | 'used');
      setAuthUsername('');
      setAuthPassword('');
      setAuthError('');
      setAuthModalVisible(true);
      return;
    }
    setActiveTab(key as 'list' | 'available' | 'used');
  };

  const handleAuth = async () => {
    if (!authUsername || !authPassword) {
      setAuthError('请输入用户名和密码');
      return;
    }
    setAuthLoading(true);
    setAuthError('');
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: authUsername, password: authPassword }),
      });
      const json = await res.json();
      if (json.success) {
        setUnlocked(true);
        setAuthModalVisible(false);
        setActiveTab(authTargetTab);
      } else {
        setAuthError(json.message || '用户名或密码错误');
      }
    } catch {
      setAuthError('验证请求失败，请重试');
    } finally {
      setAuthLoading(false);
    }
  };

  /** 发送 Google Chat 通知 */
  const sendChatNotify = async (text: string) => {
    try {
      await fetch(
        'https://chat.googleapis.com/v1/spaces/AAQAbOJ7OrU/messages?key=AIzaSyDdI0hCZtE6vySjMm-WEfRq3CPzqKqqsHI&token=l-0XPEoX1fO1v-CB3yKCXwgxdljymj9WSfarNxnfLTA',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text }),
        }
      );
    } catch {
      // 通知失败静默处理，不影响主流程
    }
  };

  /** 分组级「申请使用」：验证当前登录账号密码后解锁该分组的导出 */
  const handleGroupApply = async () => {
    if (!applyPassword) {
      setApplyError('请输入密码');
      return;
    }
    setApplyLoading(true);
    setApplyError('');
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: user?.username, password: applyPassword }),
      });
      const json = await res.json();
      if (json.success) {
        setUnlockedGroups(prev => new Set([...prev, applyTargetAsn]));
        setGroupApplyModalVisible(false);
        setApplyPassword('');
        message.success(`已申请使用 ${applyTargetAsn} 分组`);
        const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
        const grpRemark = groupMeta[applyTargetAsn]?.remark;
        sendChatNotify(`🔓 申请使用通知\n账号: ${user?.username}\n分组: ${GROUP_LABEL[group]} — ${applyTargetAsn}${grpRemark ? `（${grpRemark}）` : ''}\n时间: ${now}`);
      } else {
        setApplyError('密码错误，请重新输入');
      }
    } catch {
      setApplyError('验证请求失败，请重试');
    } finally {
      setApplyLoading(false);
    }
  };

  /** 单分组导出 Excel */
  const handleExportGroupExcel = (asn: string, grpItems: AsnStandbyItem[]) => {
    const sheetRows: (string | number)[][] = [
      ['IP 段', '月费($)', '供应商', '使用地区', '购买时间', '续费日', '续费状态', '被墙国家', '可用国家', '被墙时间', '备注', '使用状态', '收录时间'],
    ];
    for (const item of grpItems) {
      const seg = getSegInfo(item.segment);
      const bi = item.blockedInfo;
      const renewalDisplay = seg?.renewalStatus ? (RENEWAL_STATUS_DISPLAY[seg.renewalStatus]?.text || '') : '';
      sheetRows.push([
        item.segment,
        seg?.monthlyPrice != null ? Number(seg.monthlyPrice) : '',
        seg?.supplier || '',
        seg?.usageArea || '',
        seg?.purchaseDate || '',
        seg?.renewalDate || '',
        renewalDisplay,
        (bi?.countries || []).map(c => (COUNTRY_LABEL[c] || c) + '被墙').join('、'),
        (bi?.availableCountries || []).map(c => (COUNTRY_LABEL[c] || c) + '可用').join('、'),
        bi?.blockedAt || '',
        item.remark || seg?.remark || '',
        item.usageStatus === 'used' ? '已使用' : '检测可用',
        item.availableAddedAt?.slice(0, 10) || '',
      ]);
    }
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(sheetRows);
    const sheetName = asn.replace(/[\\/*?[\]:]/g, '_').slice(0, 31);
    XLSX.utils.book_append_sheet(wb, ws, sheetName);
    const fileName = `检测可用_${GROUP_LABEL[group]}_${sheetName}_${dayjs().format('YYYYMMDD_HHmm')}.xlsx`;
    XLSX.writeFile(wb, fileName);
    message.success(`已导出 ${grpItems.length} 条数据`);
    const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    const grpRemark = groupMeta[asn]?.remark;
    const segments = grpItems.map(i => i.segment).join(', ');
    sendChatNotify(`📥 导出 Excel 通知\n账号: ${user?.username}\n分组: ${GROUP_LABEL[group]} — ${asn}${grpRemark ? `（${grpRemark}）` : ''}\nIP 段数: ${grpItems.length} 条\nIP 段: ${segments}\n文件: ${fileName}\n时间: ${now}`);
  };

  // ── 表格列定义 ────────────────────────────────────────────────────────────

  /** 被墙信息列渲染 */
  const renderBlockedInfo = (record: AsnStandbyItem) => {
    const bi = record.blockedInfo;
    const hasBlocked = bi?.countries?.length;
    const hasAvailable = bi?.availableCountries?.length;
    if (!bi || (!hasBlocked && !hasAvailable && !bi.note)) {
      return <span style={{ color: '#ccc' }}>-</span>;
    }
    return (
      <Space size={4} wrap>
        {(bi.countries || []).map(c => (
          <Tag key={`b-${c}`} color={COUNTRY_TAG_COLOR[c] || 'default'} style={{ fontSize: 11 }}>
            {COUNTRY_LABEL[c] || c}被墙
          </Tag>
        ))}
        {(bi.availableCountries || []).map(c => (
          <Tag key={`a-${c}`} color="green" style={{ fontSize: 11 }}>
            {COUNTRY_LABEL[c] || c}可用
          </Tag>
        ))}
        {bi.blockedAt && (
          <span style={{ fontSize: 11, color: '#999' }}>{bi.blockedAt}</span>
        )}
        {bi.note && (
          <Tooltip title={bi.note}>
            <span style={{ fontSize: 11, color: '#666', cursor: 'help', textDecoration: 'underline dotted' }}>
              备注
            </span>
          </Tooltip>
        )}
      </Space>
    );
  };

  /** 构建表格列（tabType: list=IP段列表, available=检测可用, used=已使用） */
  const buildColumns = (tabType: 'list' | 'available' | 'used', isViewer = false) => {
    const isAvailableTab = tabType === 'available';
    const isUsedTab = tabType === 'used';
    const isListTab = tabType === 'list';

    const cols: any[] = [
    {
      title: 'IP 段',
      key: 'segment',
      width: 170,
      render: (_: any, record: AsnStandbyItem) => (
        <Space size={4}>
          <span style={{ fontFamily: 'monospace', fontWeight: 600 }}>{record.segment}</span>
          <Tooltip title="点击复制">
            <CopyOutlined
              style={{ fontSize: 12, color: '#bbb', cursor: 'pointer' }}
              onClick={() => {
                navigator.clipboard.writeText(record.segment).then(() => {
                  message.success(`已复制 ${record.segment}`, 1);
                }).catch(() => {
                  message.error('复制失败');
                });
              }}
            />
          </Tooltip>
        </Space>
      ),
    },
    {
      title: 'ASN',
      key: 'asn',
      width: 120,
      render: (_: any, record: AsnStandbyItem) => {
        const seg = getSegInfo(record.segment);
        if (!seg?.asn) return <span style={{ color: '#ccc' }}>-</span>;
        return <Tag color="blue" style={{ fontFamily: 'monospace' }}>{seg.asn}</Tag>;
      },
    },
    {
      title: '月费',
      key: 'price',
      width: 90,
      align: 'right' as const,
      render: (_: any, record: AsnStandbyItem) => {
        const seg = getSegInfo(record.segment);
        return seg?.monthlyPrice != null
          ? <span style={{ fontWeight: 600 }}>${Number(seg.monthlyPrice).toFixed(2)}</span>
          : '-';
      },
    },
    {
      title: '供应商',
      key: 'supplier',
      width: 100,
      render: (_: any, record: AsnStandbyItem) => {
        const seg = getSegInfo(record.segment);
        return seg?.supplier || <span style={{ color: '#ccc' }}>-</span>;
      },
    },
    {
      title: '使用地区',
      key: 'usageArea',
      width: 100,
      render: (_: any, record: AsnStandbyItem) => {
        const seg = getSegInfo(record.segment);
        return seg?.usageArea ? <Tag>{seg.usageArea}</Tag> : <span style={{ color: '#ccc' }}>-</span>;
      },
    },
    {
      title: '购买时间',
      key: 'purchaseDate',
      width: 110,
      render: (_: any, record: AsnStandbyItem) => {
        const seg = getSegInfo(record.segment);
        if (!seg?.purchaseDate) return <span style={{ color: '#ccc' }}>-</span>;
        return <span style={{ fontSize: 13 }}>{seg.purchaseDate}</span>;
      },
    },
    {
      title: '续费日',
      key: 'renewalDate',
      width: 110,
      render: (_: any, record: AsnStandbyItem) => {
        const seg = getSegInfo(record.segment);
        if (!seg?.renewalDate) return '-';
        const daysLeft = dayjs(seg.renewalDate).diff(dayjs(), 'day');
        const color = daysLeft <= 3 ? 'red' : daysLeft <= 7 ? 'orange' : daysLeft <= 14 ? 'gold' : 'default';
        return (
          <Tooltip title={`还剩 ${daysLeft} 天`}>
            <Tag color={color}>{seg.renewalDate}</Tag>
          </Tooltip>
        );
      },
    },
    {
      title: '被墙信息',
      key: 'blockedInfo',
      render: (_: any, record: AsnStandbyItem) => renderBlockedInfo(record),
    },
    {
      title: '宣告状态',
      key: 'announcementStatus',
      width: 120,
      render: (_: any, record: AsnStandbyItem) => {
        const status = record.announcementStatus || 'not_announced';
        const opt = ANNOUNCEMENT_STATUS_OPTIONS.find(o => o.value === status);
        return (
          <Select
            size="small"
            value={status}
            style={{ width: 110 }}
            variant="borderless"
            onChange={(val) => handleSetAnnouncement(record.segment, val as AnnouncementStatus)}
            options={ANNOUNCEMENT_STATUS_OPTIONS.map(o => ({ label: <Tag color={o.color}>{o.label}</Tag>, value: o.value }))}
            dropdownStyle={{ minWidth: 120 }}
          />
        );
      },
    },
    {
      title: '备注',
      key: 'remark',
      render: (_: any, record: AsnStandbyItem) => {
        const seg = getSegInfo(record.segment);
        const remark = record.remark || seg?.remark || '';
        if (!remark) return <span style={{ color: '#ccc' }}>-</span>;
        return (
          <span style={{ color: '#555', fontSize: 13, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
            {remark}
          </span>
        );
      },
    },
    ];

    // 检测可用和已使用 Tab 额外列
    if (isAvailableTab || isUsedTab) {
      cols.push({
        title: '收录时间',
        key: 'availableAddedAt',
        width: 110,
        render: (_: any, record: AsnStandbyItem) => (
          <span style={{ fontSize: 12, color: '#999' }}>{record.availableAddedAt?.slice(0, 10) || '-'}</span>
        ),
      });
      cols.push({
        title: '使用状态',
        key: 'usageStatus',
        width: 100,
        render: (_: any, record: AsnStandbyItem) => {
          const s = record.usageStatus || 'available';
          if (s === 'used') return <Tag color="blue">已使用</Tag>;
          return <Tag color="green">检测可用</Tag>;
        },
      });
    }
    if (isUsedTab) {
      cols.push({
        title: '启用时间',
        key: 'usedAt',
        width: 110,
        render: (_: any, record: AsnStandbyItem) => (
          <span style={{ fontSize: 12, color: '#999' }}>{record.usedAt?.slice(0, 10) || '-'}</span>
        ),
      });
    }

    // 操作列（viewer 在已使用 Tab 下不显示）
    if (!(isUsedTab && isViewer)) {
    cols.push({
      title: '操作',
      key: 'action',
      width: isListTab ? 160 : isAvailableTab ? 130 : 90,
      align: 'center' as const,
      render: (_: any, record: AsnStandbyItem) => (
        <Space size={4}>
          {isListTab && (
            <>
              <Tooltip title="编辑被墙信息">
                <Button
                  type="text"
                  size="small"
                  icon={<EditOutlined />}
                  onClick={() => openBlockedModal(record.segment)}
                />
              </Tooltip>
              {record.availableStandby ? (
                <Tooltip title="取消收录到检测可用 ASN 和 IP 段">
                  <Button
                    type="text"
                    size="small"
                    icon={<MinusCircleOutlined />}
                    style={{ color: '#faad14' }}
                    onClick={() => handleToggleAvailable(record.segment, false)}
                  />
                </Tooltip>
              ) : (
                <Tooltip title={canCollect(record) ? '收录到检测可用 ASN 和 IP 段' : '需先在被墙信息中标记「俄罗斯可用」'}>
                  <Button
                    type="text"
                    size="small"
                    icon={<CheckCircleOutlined />}
                    style={{ color: canCollect(record) ? '#52c41a' : '#d9d9d9' }}
                    onClick={() => handleToggleAvailable(record.segment, true)}
                  />
                </Tooltip>
              )}
              <Popconfirm
                title="确认从本组移除该 IP 段？"
                onConfirm={() => handleRemove(record.segment)}
                okText="移除"
                cancelText="取消"
              >
                <Button type="text" danger size="small" icon={<DeleteOutlined />} />
              </Popconfirm>
            </>
          )}
          {isAvailableTab && (
            <>
              <Tooltip title="标记为已使用（移至已使用 Tab）">
                <Button
                  type="text"
                  size="small"
                  icon={<CheckCircleOutlined />}
                  style={{ color: '#1677ff' }}
                  onClick={() => handleMarkAsUsed(record.segment)}
                />
              </Tooltip>
              <Tooltip title="取消收录">
                <Button
                  type="text"
                  size="small"
                  icon={<MinusCircleOutlined />}
                  style={{ color: '#faad14' }}
                  onClick={() => handleToggleAvailable(record.segment, false)}
                />
              </Tooltip>
            </>
          )}
          {isUsedTab && (
            <Tooltip title="恢复为检测可用">
              <Button
                type="text"
                size="small"
                icon={<MinusCircleOutlined />}
                style={{ color: '#faad14' }}
                onClick={async () => {
                  const newItems = items.map(i =>
                    i.segment === record.segment
                      ? { ...i, usageStatus: 'available' as UsageStatus, usedAt: undefined }
                      : i
                  );
                  await saveData(newItems);
                }}
              />
            </Tooltip>
          )}
        </Space>
      ),
    });
    }

    return cols;
  };

  // ── 按 ASN 分组渲染 ───────────────────────────────────────────────────────

  const renderGroupedTable = (sourceItems: AsnStandbyItem[], tabType: 'list' | 'available' | 'used') => {
    const isAvailableTab = tabType === 'available';
    const isViewer = user?.role === 'viewer';
    const groups = groupByAsn(sourceItems, getSegInfo, groupMeta);

    // 所有 ASN（不含"未设置"），用于上下移动
    const allAsns = groups.filter(g => g.asn !== '(未设置 ASN)').map(g => g.asn);

    // 批量操作栏（放在 Collapse 外部，只显示一个）
    const batchBar = (
      <>
        {isAvailableTab && selectedAvailableKeys.length > 0 && (
          <div style={{ marginBottom: 12, padding: '8px 12px', background: '#f0f9ff', borderRadius: 6, border: '1px solid #bae6fd' }}>
            <Space size={8}>
              <Text type="secondary" style={{ fontSize: 12 }}>已选 {selectedAvailableKeys.length} 个</Text>
              <Button
                size="small"
                type="primary"
                icon={<CheckCircleOutlined />}
                onClick={() => handleBatchSetUsageStatus('used')}
              >
                批量标记已使用
              </Button>
              <Button
                size="small"
                icon={<MinusCircleOutlined />}
                onClick={() => handleBatchSetUsageStatus('available')}
              >
                批量恢复可用
              </Button>
              <Button
                size="small"
                icon={<PlusOutlined />}
                onClick={() => setBatchTransferModalVisible(true)}
              >
                移回 IP 段列表
              </Button>
              <Button
                size="small"
                icon={<CopyOutlined />}
                onClick={() => {
                  const text = selectedAvailableKeys.join('\n');
                  navigator.clipboard.writeText(text).then(() => {
                    message.success(`已复制 ${selectedAvailableKeys.length} 个 IP 段`);
                  }).catch(() => message.error('复制失败'));
                }}
              >
                复制 IP 段
              </Button>
              <Button size="small" onClick={() => setSelectedAvailableKeys([])}>取消选择</Button>
            </Space>
          </div>
        )}
        {tabType === 'list' && selectedListKeys.length > 0 && (
          <div style={{ marginBottom: 12, padding: '8px 12px', background: '#f6ffed', borderRadius: 6, border: '1px solid #b7eb8f' }}>
            <Space size={8}>
              <Text type="secondary" style={{ fontSize: 12 }}>已选 {selectedListKeys.length} 个</Text>
              <Button
                size="small"
                type="primary"
                icon={<CheckCircleOutlined />}
                style={{ background: '#52c41a', borderColor: '#52c41a' }}
                onClick={handleBatchCollect}
              >
                批量收录
              </Button>
              <Button
                size="small"
                icon={<EditOutlined />}
                onClick={() => setBatchEditModalVisible(true)}
              >
                批量编辑
              </Button>
              <Button
                size="small"
                icon={<CopyOutlined />}
                onClick={() => {
                  const text = selectedListKeys.join('\n');
                  navigator.clipboard.writeText(text).then(() => {
                    message.success(`已复制 ${selectedListKeys.length} 个 IP 段`);
                  }).catch(() => message.error('复制失败'));
                }}
              >
                复制 IP 段
              </Button>
              <Popconfirm
                title={`确认从本组移除所选 ${selectedListKeys.length} 个 IP 段？`}
                onConfirm={handleBatchRemove}
                okText="移除"
                cancelText="取消"
                okButtonProps={{ danger: true }}
              >
                <Button size="small" danger icon={<DeleteOutlined />}>
                  批量移除
                </Button>
              </Popconfirm>
              <Button size="small" onClick={() => setSelectedListKeys([])}>取消选择</Button>
            </Space>
          </div>
        )}
      </>
    );

    if (groups.length === 0) {
      return (
        <>
          {batchBar}
          <Empty
            description={
              tabType === 'list'
                ? <span>{GROUP_LABEL[group]} 暂无 IP 段，<Button type="link" onClick={() => setAddModalVisible(true)}>点击添加</Button></span>
                : tabType === 'available'
                ? '暂无已收录的 IP 段（需先在 IP 段列表中登记被墙信息并标记「俄罗斯可用」后收录）'
                : '暂无已使用的 IP 段'
            }
          />
        </>
      );
    }

    const defaultActiveKeys = tabType === 'available' ? [] : groups.map(g => g.asn);

    return (
      <>
        {batchBar}
        <Collapse defaultActiveKey={defaultActiveKeys} ghost>
          {groups.map(({ asn, items: grpItems }, groupIdx) => {
            const availableCount = grpItems.filter(i => i.availableStandby).length;
            const grpRemark = groupMeta[asn]?.remark || '';
            const isFirst = groupIdx === 0 || (groupIdx === 0 && asn !== '(未设置 ASN)');
            const isLast = groupIdx === allAsns.length - 1 && asn !== '(未设置 ASN)';
            return (
              <Panel
                key={asn}
                header={
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', width: '100%', justifyContent: 'space-between' }}>
                    {/* 左侧：ASN标签、数量、备注、排序 */}
                    <Space size={8} wrap>
                      <Tag color={asn === '(未设置 ASN)' ? 'default' : 'blue'} style={{ fontFamily: 'monospace', fontWeight: 600 }}>
                        {asn}
                      </Tag>
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        {grpItems.length} 个 IP 段
                      </Text>
                      {tabType === 'list' && availableCount > 0 && (
                        <Badge count={availableCount} size="small" color="green" title={`${availableCount} 个已收录到检测可用 ASN 和 IP 段`} />
                      )}
                      {/* 分组备注 */}
                      {editingGroupAsn === asn ? (
                        <Space size={4} onClick={e => e.stopPropagation()}>
                          <Input
                            size="small"
                            autoFocus
                            value={editingGroupRemark}
                            onChange={e => setEditingGroupRemark(e.target.value)}
                            style={{ width: 160 }}
                            onPressEnter={() => handleSaveGroupRemark(asn, editingGroupRemark)}
                            placeholder="输入分组备注"
                          />
                          <Button size="small" type="text" icon={<CheckCircleOutlined style={{ color: '#52c41a' }} />} loading={saving} onClick={() => handleSaveGroupRemark(asn, editingGroupRemark)} />
                          <Button size="small" type="text" onClick={() => setEditingGroupAsn(null)}>✕</Button>
                        </Space>
                      ) : (
                        <Space size={4} onClick={e => e.stopPropagation()}>
                          {grpRemark && <span style={{ color: '#888', fontSize: 12 }}>— {grpRemark}</span>}
                          <Button
                            size="small"
                            type="text"
                            icon={<EditOutlined style={{ fontSize: 11, color: '#bbb' }} />}
                            onClick={() => { setEditingGroupAsn(asn); setEditingGroupRemark(grpRemark); }}
                          />
                        </Space>
                      )}
                    {/* 上下移动按钮（列表Tab和检测可用Tab，非"未设置ASN"组） */}
                    {(tabType === 'list' || tabType === 'available') && asn !== '(未设置 ASN)' && (
                        <Space size={2} onClick={e => e.stopPropagation()}>
                          <Button
                            size="small" type="text"
                            icon={<span style={{ fontSize: 12, color: groupIdx === 0 ? '#ccc' : '#666' }}>↑</span>}
                            disabled={groupIdx === 0}
                            onClick={() => handleMoveGroup(asn, 'up', allAsns)}
                          />
                          <Button
                            size="small" type="text"
                            icon={<span style={{ fontSize: 12, color: isLast ? '#ccc' : '#666' }}>↓</span>}
                            disabled={isLast}
                            onClick={() => handleMoveGroup(asn, 'down', allAsns)}
                          />
                        </Space>
                      )}
                    </Space>
                    {/* 右侧：检测可用 Tab 的申请使用 + 导出按钮 */}
                    {isAvailableTab && (
                      <Space size={4} onClick={e => e.stopPropagation()}>
                        {!unlockedGroups.has(asn) ? (
                          <Button
                            size="small"
                            type="primary"
                            icon={<LockOutlined />}
                            onClick={() => {
                              setApplyTargetAsn(asn);
                              setApplyPassword('');
                              setApplyError('');
                              setGroupApplyModalVisible(true);
                            }}
                          >
                            申请使用
                          </Button>
                        ) : (
                          <Tag color="green" style={{ cursor: 'default' }}>已申请</Tag>
                        )}
                        <Button
                          size="small"
                          icon={<DownloadOutlined />}
                          disabled={!unlockedGroups.has(asn)}
                          onClick={() => handleExportGroupExcel(asn, grpItems)}
                        >
                          导出 Excel
                        </Button>
                      </Space>
                    )}
                  </div>
                }
              >
                <Table
                  dataSource={grpItems}
                  rowKey="segment"
                  columns={buildColumns(tabType, isViewer)}
                  size="small"
                  pagination={false}
                  scroll={{ x: 1000 }}
                  loading={saving}
                  rowSelection={isAvailableTab ? {
                    selectedRowKeys: selectedAvailableKeys,
                    onChange: (keys) => setSelectedAvailableKeys(keys as string[]),
                  } : tabType === 'list' ? {
                    selectedRowKeys: selectedListKeys,
                    onChange: (keys) => setSelectedListKeys(keys as string[]),
                  } : undefined}
                />
              </Panel>
            );
          })}
        </Collapse>
      </>
    );
  };

  // ── 导出 Excel ────────────────────────────────────────────────────────────

  const handleExportExcel = (exportType: 'available' | 'used' = 'available') => {
    const exportItems = exportType === 'used'
      ? items.filter(i => i.availableStandby === true && i.usageStatus === 'used')
      : items.filter(i => i.availableStandby === true);
    if (exportItems.length === 0) {
      message.warning(exportType === 'used' ? '暂无已使用的 IP 段可导出' : '暂无已收录的 IP 段可导出');
      return;
    }

    const groups = groupByAsn(exportItems, getSegInfo);
    const wb = XLSX.utils.book_new();
    const allRows: (string | number)[][] = [
      ['ASN', 'IP 段', '月费($)', '供应商', '使用地区', '续费日', '续费状态', '被墙国家', '可用国家', '被墙时间', '备注', '使用状态', '收录时间'],
    ];

    for (const { asn, items: grpItems } of groups) {
      for (const item of grpItems) {
        const seg = getSegInfo(item.segment);
        const bi = item.blockedInfo;
        const renewalDisplay = seg?.renewalStatus ? (RENEWAL_STATUS_DISPLAY[seg.renewalStatus]?.text || '') : '';
        allRows.push([
          asn,
          item.segment,
          seg?.monthlyPrice != null ? Number(seg.monthlyPrice) : '',
          seg?.supplier || '',
          seg?.usageArea || '',
          seg?.renewalDate || '',
          renewalDisplay,
          (bi?.countries || []).map(c => (COUNTRY_LABEL[c] || c) + '被墙').join('、'),
          (bi?.availableCountries || []).map(c => (COUNTRY_LABEL[c] || c) + '可用').join('、'),
          bi?.blockedAt || '',
          bi?.note || '',
          item.usageStatus === 'used' ? '已使用' : '检测可用',
          item.availableAddedAt?.slice(0, 10) || '',
        ]);
      }

      const sheetRows: (string | number)[][] = [
        ['IP 段', '月费($)', '供应商', '使用地区', '续费日', '续费状态', '被墙国家', '可用国家', '被墙时间', '备注', '使用状态', '收录时间'],
      ];
      for (const item of grpItems) {
        const seg = getSegInfo(item.segment);
        const bi = item.blockedInfo;
        const renewalDisplay = seg?.renewalStatus ? (RENEWAL_STATUS_DISPLAY[seg.renewalStatus]?.text || '') : '';
        sheetRows.push([
          item.segment,
          seg?.monthlyPrice != null ? Number(seg.monthlyPrice) : '',
          seg?.supplier || '',
          seg?.usageArea || '',
          seg?.renewalDate || '',
          renewalDisplay,
          (bi?.countries || []).map(c => (COUNTRY_LABEL[c] || c) + '被墙').join('、'),
          (bi?.availableCountries || []).map(c => (COUNTRY_LABEL[c] || c) + '可用').join('、'),
          bi?.blockedAt || '',
          bi?.note || '',
          item.usageStatus === 'used' ? '已使用' : '检测可用',
          item.availableAddedAt?.slice(0, 10) || '',
        ]);
      }
      const sheetName = asn.replace(/[\\/*?[\]:]/g, '_').slice(0, 31);
      const ws = XLSX.utils.aoa_to_sheet(sheetRows);
      XLSX.utils.book_append_sheet(wb, ws, sheetName);
    }

    const summaryWs = XLSX.utils.aoa_to_sheet(allRows);
    XLSX.utils.book_append_sheet(wb, summaryWs, '汇总');
    wb.SheetNames = ['汇总', ...wb.SheetNames.filter(n => n !== '汇总')];

    const fileName = `${exportType === 'used' ? '已使用ASN及IP段' : '检测可用ASN和IP段'}_${GROUP_LABEL[group]}_${dayjs().format('YYYYMMDD_HHmm')}.xlsx`;
    XLSX.writeFile(wb, fileName);
    message.success(`已导出 ${exportItems.length} 条数据`);
  };

  // ── 数据分类 ──────────────────────────────────────────────────────────────

  // IP段列表 Tab：不显示已收录的 IP 段
  const listItems = items.filter(i => !i.availableStandby);
  // 检测可用 Tab：已收录且使用状态为 available
  const availableItems = items.filter(i => i.availableStandby === true && (i.usageStatus || 'available') === 'available');
  // 已使用 Tab：已收录且使用状态为 used
  const usedItems = items.filter(i => i.availableStandby === true && i.usageStatus === 'used');

  // ── 渲染 ──────────────────────────────────────────────────────────────────

  const lockedContent = (
    <Card>
      <div style={{ textAlign: 'center', padding: '48px 0' }}>
        <LockOutlined style={{ fontSize: 48, color: '#bbb', marginBottom: 16 }} />
        <div style={{ color: '#999', marginBottom: 16 }}>此区域受密码保护，请验证身份后查看</div>
        <Button
          type="primary"
          icon={<LockOutlined />}
          onClick={() => {
            setAuthUsername('');
            setAuthPassword('');
            setAuthError('');
            setAuthModalVisible(true);
          }}
        >
          点击解锁
        </Button>
      </div>
    </Card>
  );

  const tabItems = [
    {
      key: 'list',
      label: (
        <Space>
          <SafetyCertificateOutlined />
          IP 段列表
          <Badge count={listItems.length} size="small" color={GROUP_COLOR[group] === 'blue' ? '#1677ff' : '#722ed1'} />
        </Space>
      ),
      children: (
        <Card>
          {loading ? null : (
            <>
              {(() => {
                // 统计列表中未检测俄罗斯的 IP 段数量
                const undetectedRussia = listItems.filter(i => {
                  const bi = i.blockedInfo;
                  const hasRussiaInfo = (bi?.countries || []).includes('russia') || (bi?.availableCountries || []).includes('russia');
                  return !hasRussiaInfo;
                });
                if (undetectedRussia.length === 0) return null;
                return (
                  <Alert
                    type="warning"
                    showIcon
                    style={{ marginBottom: 12 }}
                    message={`${undetectedRussia.length} 个 IP 段尚未检测俄罗斯可用性`}
                    description={
                      <span>
                        该列表中有 <strong>{undetectedRussia.length}</strong> 个 IP 段的被墙信息中未包含俄罗斯检测结果。
                        检测完成后，若俄罗斯可用，请在「编辑被墙信息」中将「可用国家」勾选「俄罗斯可用」，
                        然后点击收录按钮将其收录到「检测可用」页面。
                      </span>
                    }
                  />
                );
              })()}
              {renderGroupedTable(listItems, 'list')}
            </>
          )}
        </Card>
      ),
    },
    {
      key: 'available',
      label: (
        <Space>
          <LockOutlined />
          检测可用 ASN 和 IP 段
          {availableItems.length > 0 && (
            <Badge count={availableItems.length} size="small" color="green" />
          )}
        </Space>
      ),
      children: unlocked ? (
        <Card>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <Alert
              type="success"
              message="已解锁 · 检测可用 ASN 和 IP 段"
              description="此列表展示运维已标记为「检测可用」的备用 IP 段。点击启用按钮可将 IP 段移入「已使用」分页。"
              showIcon
              style={{ flex: 1, marginRight: 12 }}
            />
            {user?.role !== 'viewer' && (
              <Button
                icon={<DownloadOutlined />}
                type="primary"
                ghost
                onClick={() => handleExportExcel('available')}
                disabled={availableItems.length === 0}
              >
                导出 Excel
              </Button>
            )}
          </div>
          {renderGroupedTable(availableItems, 'available')}
        </Card>
      ) : lockedContent,
    },
    {
      key: 'used',
      label: (
        <Space>
          <LockOutlined />
          已使用 ASN 及 IP 段
          {usedItems.length > 0 && (
            <Badge count={usedItems.length} size="small" color="blue" />
          )}
        </Space>
      ),
      children: unlocked ? (
        <Card>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <Alert
              type="info"
              message="已使用 ASN 及 IP 段"
              description={user?.role === 'viewer'
                ? '此列表展示已启用的 IP 段（只读）。'
                : '此列表展示已启用的 IP 段。可点击操作列中的「恢复可用」按钮将其移回检测可用列表。'}
              showIcon
              style={{ flex: 1, marginRight: 12 }}
            />
            <Button
              icon={<DownloadOutlined />}
              type="primary"
              ghost
              onClick={() => handleExportExcel('used')}
              disabled={usedItems.length === 0}
            >
              导出 Excel
            </Button>
          </div>
          {renderGroupedTable(usedItems, 'used')}
        </Card>
      ) : lockedContent,
    },
  ];

  return (
    <div>
      {/* 页头 */}
      <Card style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Space>
            <StarOutlined style={{ color: GROUP_COLOR[group] === 'blue' ? '#1677ff' : '#722ed1', fontSize: 18 }} />
            <Title level={4} style={{ margin: 0 }}>
              <Tag color={GROUP_COLOR[group]} style={{ fontSize: 14 }}>{group} 组</Tag>
              备用 AS
            </Title>
            <Text type="secondary" style={{ fontSize: 13 }}>
              共 {items.length} 个 IP 段，{availableItems.length} 个检测可用，{usedItems.length} 个已使用
            </Text>
          </Space>
          <Space>
            <Button icon={<ReloadOutlined />} onClick={loadData} loading={loading}>刷新</Button>
            <Button
              type="primary"
              icon={<PlusOutlined />}
              onClick={() => { setAddModalVisible(true); setSearchText(''); setSelectedToAdd([]); setAddMode('select'); setBatchInputText(''); }}
            >
              添加 IP 段
            </Button>
          </Space>
        </div>
      </Card>

      {/* 主 Tabs */}
      <Tabs
        activeKey={activeTab}
        onChange={handleTabChange}
        items={tabItems}
        style={{ background: 'transparent' }}
      />

      {/* 添加 IP 段弹窗 */}
      <Modal
        title={`添加 IP 段到 ${GROUP_LABEL[group]}`}
        open={addModalVisible}
        onCancel={() => setAddModalVisible(false)}
        onOk={handleAdd}
        okText="添加"
        cancelText="取消"
        width={700}
        confirmLoading={saving}
        okButtonProps={{ disabled: addMode === 'select' ? selectedToAdd.length === 0 : !batchInputText.trim() }}
      >
        <Space direction="vertical" style={{ width: '100%' }} size={12}>
          <Radio.Group
            value={addMode}
            onChange={e => setAddMode(e.target.value)}
            optionType="button"
            buttonStyle="solid"
            size="small"
          >
            <Radio.Button value="select">从 IP 段管理选择</Radio.Button>
            <Radio.Button value="batch">批量输入</Radio.Button>
          </Radio.Group>

          {addMode === 'select' ? (
            <>
              <Input.Search
                placeholder="搜索 IP 段、ASN、备注..."
                value={searchText}
                onChange={e => setSearchText(e.target.value)}
                allowClear
              />
              <Text type="secondary" style={{ fontSize: 12 }}>
                从 IP 段管理中选择 IP 段加入本组（已加入的不显示）。已选 {selectedToAdd.length} 个。
              </Text>
              <Divider style={{ margin: '4px 0' }} />
              <Select
                mode="multiple"
                style={{ width: '100%' }}
                placeholder="选择 IP 段（按 ASN 分组展示）..."
                value={selectedToAdd}
                onChange={setSelectedToAdd}
                showSearch
                filterOption={(input, option) => {
                  if (!option) return false;
                  const lbl = (option.label as string || '').toLowerCase();
                  const val = ((option as any).value as string || '').toLowerCase();
                  const q = input.toLowerCase();
                  return lbl.includes(q) || val.includes(q);
                }}
                options={groupedAvailableOptions}
                maxTagCount={6}
                listHeight={320}
                optionRender={(opt) => {
                  const seg = allSegments.find(s => s.segment === opt.value);
                  if (!seg) return <span>{String(opt.value)}</span>;
                  return (
                    <Space size={6}>
                      <span style={{ fontFamily: 'monospace', fontWeight: 600 }}>{seg.segment}</span>
                      {seg.supplier && <Tag style={{ fontSize: 11 }}>{seg.supplier}</Tag>}
                      {seg.usageArea && <Tag color="cyan" style={{ fontSize: 11 }}>{seg.usageArea}</Tag>}
                      {seg.remark && <span style={{ color: '#999', fontSize: 12 }}>{seg.remark}</span>}
                    </Space>
                  );
                }}
              />
            </>
          ) : (
            <>
              <Text type="secondary" style={{ fontSize: 12 }}>
                每行输入一个 IP 段（格式：x.x.x.x/xx），支持换行、逗号、空格分隔，已在本组的会自动跳过。
              </Text>
              <Input.TextArea
                autoFocus
                rows={10}
                placeholder={`例如：\n1.2.3.0/24\n4.5.6.0/23\n7.8.9.0/24`}
                value={batchInputText}
                onChange={e => setBatchInputText(e.target.value)}
                style={{ fontFamily: 'monospace', fontSize: 13 }}
              />
              {batchInputText.trim() && (() => {
                const lines = batchInputText.split(/[\n,，\s]+/).map(s => s.trim()).filter(Boolean);
                const valid = lines.filter(s => /^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/.test(s));
                const invalid = lines.filter(s => !/^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/.test(s));
                const alreadyIn = valid.filter(s => items.some(i => i.segment === s));
                return (
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    识别到 <Text strong>{valid.length}</Text> 个有效 IP 段
                    {alreadyIn.length > 0 && <>，其中 <Text type="warning">{alreadyIn.length} 个已在本组</Text></>}
                    {invalid.length > 0 && <>，<Text type="danger">{invalid.length} 行格式无效</Text></>}
                  </Text>
                );
              })()}
            </>
          )}
        </Space>
      </Modal>

      {/* 编辑被墙信息弹窗 */}
      <Modal
        title={`编辑被墙 / 可用信息 — ${editingSegment || ''}`}
        open={blockedModalVisible}
        onCancel={() => { setBlockedModalVisible(false); setEditingSegment(null); }}
        onOk={handleBlockedSave}
        okText="保存"
        cancelText="取消"
        confirmLoading={saving}
        width={520}
      >
        <Form form={blockedForm} layout="vertical">
          <Form.Item name="countries" label="被墙国家">
            <Checkbox.Group>
              <Space wrap>
                {BLOCKED_COUNTRY_OPTIONS.map(opt => (
                  <Checkbox key={opt.value} value={opt.value}>
                    <Tag color={COUNTRY_TAG_COLOR[opt.value] || 'default'}>{opt.label}被墙</Tag>
                  </Checkbox>
                ))}
              </Space>
            </Checkbox.Group>
          </Form.Item>
          <Form.Item name="availableCountries" label="可用国家（检测可用）">
            <Checkbox.Group>
              <Space wrap>
                {BLOCKED_COUNTRY_OPTIONS.map(opt => (
                  <Checkbox key={opt.value} value={opt.value}>
                    <Tag color="green">{opt.label}可用</Tag>
                  </Checkbox>
                ))}
              </Space>
            </Checkbox.Group>
          </Form.Item>
          <Form.Item name="blockedAt" label="被墙时间">
            <DatePicker style={{ width: '100%' }} placeholder="选择被墙日期（可选）" />
          </Form.Item>
          <Form.Item name="note" label="被墙说明（悬停显示在被墙信息列）">
            <Input.TextArea rows={2} placeholder="被墙/可用相关说明（可选）" />
          </Form.Item>
          <Form.Item name="remark" label="备注（直接显示在备注列）">
            <Input.TextArea rows={3} placeholder="IP 段备注内容，保存后直接显示在备注列" />
          </Form.Item>
        </Form>
      </Modal>

      {/* 检测可用 Tab：批量转移到 IP 段列表弹窗 */}
      <Modal
        title={`移回 IP 段列表 — 已选 ${selectedAvailableKeys.length} 个 IP 段`}
        open={batchTransferModalVisible}
        onCancel={() => setBatchTransferModalVisible(false)}
        onOk={handleBatchTransferToIPManagement}
        okText="确认移回"
        cancelText="取消"
        confirmLoading={batchTransferring}
        width={440}
      >
        <Space direction="vertical" style={{ width: '100%' }} size={12}>
          <Alert
            type="info"
            showIcon
            message={`将把 ${selectedAvailableKeys.length} 个 IP 段移回「IP 段列表」Tab`}
            description="取消收录后，这些 IP 段将重新出现在 IP 段列表 Tab，可重新编辑被墙信息后再次收录。"
          />
        </Space>
      </Modal>

      {/* 批量编辑整合弹窗 */}
      <Modal
        title={`批量编辑 — 已选 ${selectedListKeys.length} 个 IP 段`}
        open={batchEditModalVisible}
        onCancel={() => setBatchEditModalVisible(false)}
        footer={null}
        width={540}
      >
        <Space direction="vertical" style={{ width: '100%' }} size={8}>
          <Alert type="info" showIcon message="选择要批量编辑的内容，将覆盖所选 IP 段的现有数据" style={{ fontSize: 13 }} />
          <Button block icon={<EditOutlined />} onClick={() => { setBatchEditModalVisible(false); setBatchRemarkValue(''); setBatchRemarkModalVisible(true); }}>
            批量编辑备注
          </Button>
          <Button block icon={<EditOutlined />} onClick={() => { setBatchEditModalVisible(false); batchBlockedForm.resetFields(); setBatchBlockedModalVisible(true); }}>
            批量编辑被墙信息
          </Button>
          <Button block icon={<EditOutlined />} onClick={() => { setBatchEditModalVisible(false); setBatchAnnouncementModalVisible(true); }}>
            批量设置宣告状态
          </Button>
        </Space>
      </Modal>

      {/* 批量设置宣告状态弹窗 */}
      <Modal
        title={`批量设置宣告状态 — 已选 ${selectedListKeys.length} 个 IP 段`}
        open={batchAnnouncementModalVisible}
        onCancel={() => setBatchAnnouncementModalVisible(false)}
        footer={null}
        width={380}
      >
        <Space direction="vertical" style={{ width: '100%' }} size={8}>
          {ANNOUNCEMENT_STATUS_OPTIONS.map(opt => (
            <Button
              key={opt.value}
              block
              onClick={() => handleBatchSetAnnouncement(opt.value)}
              loading={saving}
            >
              <Tag color={opt.color}>{opt.label}</Tag>
            </Button>
          ))}
        </Space>
      </Modal>

      {/* 批量编辑备注弹窗 */}
      <Modal
        title={`批量编辑备注 — 已选 ${selectedListKeys.length} 个 IP 段`}
        open={batchRemarkModalVisible}
        onCancel={() => { setBatchRemarkModalVisible(false); setBatchRemarkValue(''); }}
        onOk={handleBatchEditRemark}
        okText="保存"
        cancelText="取消"
        confirmLoading={saving}
        width={460}
      >
        <Space direction="vertical" style={{ width: '100%' }} size={12}>
          <Alert type="warning" showIcon message="将覆盖所选 IP 段的现有备注内容" style={{ fontSize: 13 }} />
          <Input.TextArea
            rows={4}
            placeholder="输入备注内容（留空则清除备注）"
            value={batchRemarkValue}
            onChange={e => setBatchRemarkValue(e.target.value)}
          />
        </Space>
      </Modal>

      {/* 批量编辑被墙信息弹窗 */}
      <Modal
        title={`批量编辑被墙信息 — 已选 ${selectedListKeys.length} 个 IP 段`}
        open={batchBlockedModalVisible}
        onCancel={() => { setBatchBlockedModalVisible(false); batchBlockedForm.resetFields(); }}
        onOk={handleBatchEditBlocked}
        okText="保存"
        cancelText="取消"
        confirmLoading={saving}
        width={520}
      >
        <Alert type="warning" showIcon message="将覆盖所选 IP 段的现有被墙信息" style={{ fontSize: 13, marginBottom: 16 }} />
        <Form form={batchBlockedForm} layout="vertical">
          <Form.Item name="countries" label="被墙国家">
            <Checkbox.Group>
              <Space wrap>
                {BLOCKED_COUNTRY_OPTIONS.map(opt => (
                  <Checkbox key={opt.value} value={opt.value}>
                    <Tag color={COUNTRY_TAG_COLOR[opt.value] || 'default'}>{opt.label}被墙</Tag>
                  </Checkbox>
                ))}
              </Space>
            </Checkbox.Group>
          </Form.Item>
          <Form.Item name="availableCountries" label="可用国家（检测可用）">
            <Checkbox.Group>
              <Space wrap>
                {BLOCKED_COUNTRY_OPTIONS.map(opt => (
                  <Checkbox key={opt.value} value={opt.value}>
                    <Tag color="green">{opt.label}可用</Tag>
                  </Checkbox>
                ))}
              </Space>
            </Checkbox.Group>
          </Form.Item>
          <Form.Item name="blockedAt" label="被墙时间">
            <DatePicker style={{ width: '100%' }} placeholder="选择被墙日期（可选）" />
          </Form.Item>
          <Form.Item name="note" label="被墙说明（悬停显示在被墙信息列）">
            <Input.TextArea rows={2} placeholder="被墙/可用相关说明（可选）" />
          </Form.Item>
        </Form>
      </Modal>

      {/* 分组申请使用弹窗 */}
      <Modal
        title={
          <Space>
            <LockOutlined />
            申请使用 — {applyTargetAsn}
          </Space>
        }
        open={groupApplyModalVisible}
        onCancel={() => { setGroupApplyModalVisible(false); setApplyPassword(''); setApplyError(''); }}
        onOk={handleGroupApply}
        okText="确认申请"
        cancelText="取消"
        confirmLoading={applyLoading}
        okButtonProps={{ disabled: !applyPassword }}
        width={400}
      >
        <Space direction="vertical" style={{ width: '100%', paddingTop: 8 }} size={12}>
          <Text type="secondary" style={{ fontSize: 13 }}>
            请输入您的登录密码以申请使用该分组，验证通过后可导出该分组的 IP 段信息。
          </Text>
          {applyError && (
            <Alert type="error" message={applyError} showIcon style={{ fontSize: 13 }} />
          )}
          <Input.Password
            autoFocus
            prefix={<LockOutlined style={{ color: '#bbb' }} />}
            placeholder={`${user?.username} 的登录密码`}
            value={applyPassword}
            onChange={e => setApplyPassword(e.target.value)}
            onPressEnter={handleGroupApply}
          />
        </Space>
      </Modal>

      {/* 密码验证弹窗 */}
      <Modal
        title={
          <Space>
            <LockOutlined />
            验证身份 — 检测可用 ASN 和 IP 段
          </Space>
        }
        open={authModalVisible}
        onCancel={() => setAuthModalVisible(false)}
        onOk={handleAuth}
        okText="验证"
        cancelText="取消"
        confirmLoading={authLoading}
        okButtonProps={{ disabled: !authUsername || !authPassword }}
        width={400}
      >
        <Space direction="vertical" style={{ width: '100%', paddingTop: 8 }} size={12}>
          <Text type="secondary" style={{ fontSize: 13 }}>
            此区域受密码保护，请使用您的系统账号密码验证身份后查看。
          </Text>
          {authError && (
            <Alert type="error" message={authError} showIcon style={{ fontSize: 13 }} />
          )}
          <Input
            prefix={<SafetyCertificateOutlined style={{ color: '#bbb' }} />}
            placeholder="用户名"
            value={authUsername}
            onChange={e => setAuthUsername(e.target.value)}
            onPressEnter={() => document.getElementById('asn-standby-pwd-input')?.focus()}
          />
          <Input.Password
            id="asn-standby-pwd-input"
            prefix={<LockOutlined style={{ color: '#bbb' }} />}
            placeholder="密码"
            value={authPassword}
            onChange={e => setAuthPassword(e.target.value)}
            onPressEnter={handleAuth}
          />
        </Space>
      </Modal>
    </div>
  );
};

export default AsnStandbyPage;

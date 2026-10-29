import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import {
  Table, Tabs, Button, Space, Tag, Input, Modal, message, Form, Select,
  Typography, Card, Popconfirm, Tooltip, Statistic, Row, Col, Checkbox,
} from 'antd';
import {
  PlusOutlined, EditOutlined, DeleteOutlined, SearchOutlined,
  CheckOutlined, CloseOutlined, StarOutlined, StarFilled, CopyOutlined,
} from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import dayjs from 'dayjs';
import { useUrlTab } from '../hooks/useUrlTab';
import { useAuth } from '../contexts/AuthContext';
import { IPSegment } from '../types';
import {
  ipSegmentStorage, projectGroupStorage, supplierStorage,
  usageAreaStorage, asnStorage, asnGroupStorage,
} from '../utils/storage';

const { Text } = Typography;

const SUPPLIER_COLOR_MAP: Record<string, string> = {
  'GTT': 'purple',
  'IPXO': 'cyan',
  'Larus': 'green',
  'HE': 'blue',
  'Zenlayer': 'orange',
};

const AREA_COUNTRY_MAP: Record<string, string> = {
  'liasail-洛杉矶': '美国',
  'liasail-纽约': '美国',
  '自建-圣何塞': '美国',
  'liasail-法兰克福': '德国',
};
const areaToCountry = (area: string) => AREA_COUNTRY_MAP[area] || area || '未知';

const IspManagement: React.FC = () => {
  const { hasPermission } = useAuth();
  const canEdit = hasPermission('gtt-management.edit');

  const [activeTab, setActiveTab] = useUrlTab(1, ['all', 'active', 'unused', 'cancelled'] as const, 'all');
  const [ipSegments, setIpSegments] = useState<IPSegment[]>([]);
  const [searchText, setSearchText] = useState('');

  // 使用方式内联编辑
  const [editingUsageId, setEditingUsageId] = useState<string | null>(null);
  const [editingUsageValue, setEditingUsageValue] = useState('');
  const usageSavingRef = useRef(false);

  // 备注内联编辑
  const [editingRemarkId, setEditingRemarkId] = useState<string | null>(null);
  const [editingRemarkValue, setEditingRemarkValue] = useState('');
  const remarkSavingRef = useRef(false);

  // 用户内联编辑
  const [editingUserId, setEditingUserId] = useState<string | null>(null);
  const [editingUserValue, setEditingUserValue] = useState('');
  const userSavingRef = useRef(false);

  // 手动添加 Modal
  const [addModalOpen, setAddModalOpen] = useState(false);
  const [addSearch, setAddSearch] = useState('');
  const [addSelectedKeys, setAddSelectedKeys] = useState<string[]>([]);

  // 星标取消确认
  const [unstarConfirmId, setUnstarConfirmId] = useState<string | null>(null);

  // 批量编辑
  const [selectedRowKeys, setSelectedRowKeys] = useState<string[]>([]);
  const [batchEditVisible, setBatchEditVisible] = useState(false);
  const [batchEditForm] = Form.useForm();

  const saveDataToFile = useCallback(async (silent = false) => {
    try {
      const allData = {
        ipSegments: ipSegmentStorage.getAll(),
        projectGroups: projectGroupStorage.getAll(),
        suppliers: supplierStorage.getAll(),
        usageAreas: usageAreaStorage.getAll(),
        asns: asnStorage.getAll(),
        asnGroups: asnGroupStorage.getAll(),
        exportTime: new Date().toISOString(),
        version: '1.0.0',
      };
      const resp = await fetch('/api/save-data', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(allData),
      });
      if (resp.ok) {
        if (!silent) message.success('数据已保存');
      } else {
        throw new Error('Server error');
      }
    } catch {
      message.error('数据保存失败');
    }
  }, []);

  const loadData = useCallback(() => {
    const all = ipSegmentStorage.getAll();
    let changed = false;
    const updated = all.map(seg => {
      if (seg.supplier === 'GTT' && !seg.gttManaged) {
        changed = true;
        return { ...seg, gttManaged: true, updatedAt: new Date().toISOString() };
      }
      return seg;
    });
    if (changed) {
      ipSegmentStorage.save(updated);
      saveDataToFile(true);
    }
    setIpSegments(updated);
  }, [saveDataToFile]);

  useEffect(() => {
    const fetchData = async () => {
      try {
        const resp = await fetch('/api/get-data');
        if (resp.ok) {
          const data = await resp.json();
          if (data?.ipSegments) {
            ipSegmentStorage.save(data.ipSegments);
            if (data.projectGroups) projectGroupStorage.save(data.projectGroups);
            if (data.suppliers) supplierStorage.save(data.suppliers);
            if (data.usageAreas) usageAreaStorage.save(data.usageAreas);
            if (data.asns) asnStorage.save(data.asns);
            if (data.asnGroups) asnGroupStorage.save(data.asnGroups);
          }
        }
      } catch { /* use localStorage fallback */ }
      loadData();
    };
    fetchData();
  }, [loadData]);

  // Tab 切换清空选中
  const handleTabChange = useCallback((key: string) => {
    setActiveTab(key);
    setSelectedRowKeys([]);
  }, [setActiveTab]);

  // ISP 管理的 IP 段
  const gttSegments = useMemo(() =>
    ipSegments.filter(seg => seg.gttManaged === true),
    [ipSegments],
  );

  const isCancelled = (seg: IPSegment) =>
    seg.renewalStatus === 'cancelled' || seg.renewalStatus === 'refunded' ||
    !!(seg.cancellationDate && seg.cancellationDate.trim());

  // gttInUse 手动标记优先于取消状态：
  // 在用 = 明确标记 gttInUse===true 或（未取消且未标记为 false）
  // 未使用 = 未取消且 gttInUse===false
  // 已取消 = 已取消且 gttInUse 未被手动设为 true
  const activeSegments = useMemo(() =>
    gttSegments.filter(seg => seg.gttInUse === true || (!isCancelled(seg) && seg.gttInUse !== false)),
    [gttSegments],
  );

  const unusedSegments = useMemo(() =>
    gttSegments.filter(seg => !isCancelled(seg) && seg.gttInUse === false),
    [gttSegments],
  );

  const cancelledSegments = useMemo(() =>
    gttSegments.filter(seg => isCancelled(seg) && seg.gttInUse !== true),
    [gttSegments],
  );

  // 搜索过滤（支持多个关键词，空格/逗号/换行分隔）
  const parseKeywords = useCallback((text: string): string[] => {
    if (!text.trim()) return [];
    return text.split(/[\s,，\n]+/).map(s => s.trim().toLowerCase()).filter(Boolean);
  }, []);

  const filterBySearch = useCallback((list: IPSegment[]) => {
    const keywords = parseKeywords(searchText);
    if (!keywords.length) return list;
    return list.filter(seg => {
      const fields = [
        seg.segment,
        String(seg.supplier || ''),
        String(seg.asn || ''),
        String(seg.usageMethod || ''),
        String(seg.remark || ''),
        String(seg.ispUser || ''),
      ].map(f => f.toLowerCase());
      return keywords.some(kw => fields.some(f => f.includes(kw)));
    });
  }, [searchText, parseKeywords]);

  const breakdownByCountry = (list: IPSegment[]) => {
    const map: Record<string, number> = {};
    list.forEach(s => { const c = areaToCountry(s.usageArea); map[c] = (map[c] || 0) + 1; });
    return Object.entries(map).sort((a, b) => b[1] - a[1]);
  };
  const breakdownBySupplier = (list: IPSegment[]) => {
    const map: Record<string, number> = {};
    list.forEach(s => { const sup = s.supplier || '未知'; map[sup] = (map[sup] || 0) + 1; });
    return Object.entries(map).sort((a, b) => b[1] - a[1]);
  };

  const totalByCountry = useMemo(() => breakdownByCountry(gttSegments), [gttSegments]);
  const totalBySupplier = useMemo(() => breakdownBySupplier(gttSegments), [gttSegments]);
  const activeByCountry = useMemo(() => breakdownByCountry(activeSegments), [activeSegments]);
  const activeBySupplier = useMemo(() => breakdownBySupplier(activeSegments), [activeSegments]);
  const unusedByCountry = useMemo(() => breakdownByCountry(unusedSegments), [unusedSegments]);
  const unusedBySupplier = useMemo(() => breakdownBySupplier(unusedSegments), [unusedSegments]);

  const starSort = (list: IPSegment[]) =>
    [...list].sort((a, b) => (b.ispStarred ? 1 : 0) - (a.ispStarred ? 1 : 0));

  const displayActive = useMemo(() => starSort(filterBySearch(activeSegments)), [filterBySearch, activeSegments]);
  const displayUnused = useMemo(() => starSort(filterBySearch(unusedSegments)), [filterBySearch, unusedSegments]);
  const displayCancelled = useMemo(() => starSort(filterBySearch(cancelledSegments)), [filterBySearch, cancelledSegments]);
  const displayAll = useMemo(() => starSort(filterBySearch(gttSegments)), [filterBySearch, gttSegments]);

  const currentDisplayData = useMemo(() => {
    switch (activeTab) {
      case 'active': return displayActive;
      case 'unused': return displayUnused;
      case 'cancelled': return displayCancelled;
      default: return displayAll;
    }
  }, [activeTab, displayAll, displayActive, displayUnused, displayCancelled]);

  const filteredStats = useMemo(() => {
    let inUse = 0, unused = 0, cancelled = 0;
    currentDisplayData.forEach(s => {
      if (isCancelled(s) && s.gttInUse !== true) cancelled++;
      else if (s.gttInUse === false) unused++;
      else inUse++;
    });
    return { total: currentDisplayData.length, inUse, unused, cancelled };
  }, [currentDisplayData]);

  // ── 使用方式内联编辑 ──

  const startUsageEdit = (record: IPSegment) => {
    setEditingUsageId(record.id);
    setEditingUsageValue(record.usageMethod || '');
  };

  const saveUsageInline = useCallback(() => {
    if (usageSavingRef.current || !editingUsageId) return;
    usageSavingRef.current = true;
    const seg = ipSegments.find(s => s.id === editingUsageId);
    const oldVal = seg?.usageMethod || '';
    if (editingUsageValue !== oldVal) {
      ipSegmentStorage.update(editingUsageId, { usageMethod: editingUsageValue });
      loadData();
      saveDataToFile(true);
    }
    setEditingUsageId(null);
    setTimeout(() => { usageSavingRef.current = false; }, 0);
  }, [editingUsageId, editingUsageValue, ipSegments, loadData, saveDataToFile]);

  // ── 备注内联编辑 ──

  const startRemarkEdit = (record: IPSegment) => {
    setEditingRemarkId(record.id);
    setEditingRemarkValue(record.remark || '');
  };

  const saveRemarkInline = useCallback(() => {
    if (remarkSavingRef.current || !editingRemarkId) return;
    remarkSavingRef.current = true;
    const seg = ipSegments.find(s => s.id === editingRemarkId);
    const oldVal = seg?.remark || '';
    if (editingRemarkValue !== oldVal) {
      ipSegmentStorage.update(editingRemarkId, { remark: editingRemarkValue });
      loadData();
      saveDataToFile(true);
    }
    setEditingRemarkId(null);
    setTimeout(() => { remarkSavingRef.current = false; }, 0);
  }, [editingRemarkId, editingRemarkValue, ipSegments, loadData, saveDataToFile]);

  // ── 用户内联编辑 ──

  const startUserEdit = (record: IPSegment) => {
    setEditingUserId(record.id);
    setEditingUserValue(record.ispUser || '');
  };

  const saveUserInline = useCallback(() => {
    if (userSavingRef.current || !editingUserId) return;
    userSavingRef.current = true;
    const seg = ipSegments.find(s => s.id === editingUserId);
    const oldVal = seg?.ispUser || '';
    if (editingUserValue !== oldVal) {
      ipSegmentStorage.update(editingUserId, { ispUser: editingUserValue });
      loadData();
      saveDataToFile(true);
    }
    setEditingUserId(null);
    setTimeout(() => { userSavingRef.current = false; }, 0);
  }, [editingUserId, editingUserValue, ipSegments, loadData, saveDataToFile]);

  // 星标切换
  const handleStarToggle = (record: IPSegment) => {
    ipSegmentStorage.update(record.id, { ispStarred: !record.ispStarred });
    loadData();
    saveDataToFile(true);
  };

  // 是否在用切换
  const handleInUseToggle = (record: IPSegment, checked: boolean) => {
    ipSegmentStorage.update(record.id, { gttInUse: checked });
    loadData();
    saveDataToFile(true);
  };

  // 移出 ISP 管理
  const handleRemove = (id: string) => {
    ipSegmentStorage.update(id, { gttManaged: false });
    loadData();
    saveDataToFile(true);
    message.success('已移出 ISP 管理');
  };

  // ── 手动添加 ──

  const nonGttSegments = useMemo(() => {
    if (!addModalOpen) return [];
    return ipSegments
      .filter(seg => !seg.gttManaged)
      .filter(seg => {
        const keywords = parseKeywords(addSearch);
        if (!keywords.length) return true;
        const fields = [
          seg.segment,
          String(seg.supplier || ''),
          String(seg.asn || ''),
        ].map(f => f.toLowerCase());
        return keywords.some(kw => fields.some(f => f.includes(kw)));
      });
  }, [ipSegments, addModalOpen, addSearch]);

  const handleAddConfirm = () => {
    if (!addSelectedKeys.length) { message.warning('请选择要添加的 IP 段'); return; }
    const all = ipSegmentStorage.getAll();
    const keySet = new Set(addSelectedKeys);
    const updated = all.map(seg =>
      keySet.has(seg.id) ? { ...seg, gttManaged: true, gttInUse: true, updatedAt: new Date().toISOString() } : seg,
    );
    ipSegmentStorage.save(updated);
    setIpSegments(updated);
    saveDataToFile(true);
    setAddModalOpen(false);
    setAddSelectedKeys([]);
    setAddSearch('');
    message.success(`已添加 ${addSelectedKeys.length} 个 IP 段到 ISP 管理`);
  };

  // ── 批量编辑 ──

  const handleBatchEditSubmit = async () => {
    if (!selectedRowKeys.length) { message.warning('请先选择要编辑的 IP 段'); return; }
    try {
      const values = await batchEditForm.validateFields();
      const updateData: Partial<IPSegment> = {};

      const userVal = (values.ispUser || '').trim();
      if (userVal) updateData.ispUser = userVal;

      const usageVal = (values.usageMethod || '').trim();
      if (usageVal) updateData.usageMethod = usageVal;

      if (values.gttInUse !== undefined && values.gttInUse !== null) {
        updateData.gttInUse = values.gttInUse;
      }

      if (values.ispStarred !== undefined && values.ispStarred !== null) {
        updateData.ispStarred = values.ispStarred;
      }

      const remarkVal = (values.remark || '').trim();
      const remarkOverwrite = !!values.remarkOverwrite;
      if (remarkVal && remarkOverwrite) {
        updateData.remark = remarkVal;
      }

      if (Object.keys(updateData).length === 0 && remarkVal === '') {
        message.warning('请至少填写一个要修改的字段');
        return;
      }

      let successCount = 0;
      const allSnap = ipSegmentStorage.getAll();
      selectedRowKeys.forEach(key => {
        try {
          if (remarkVal && !remarkOverwrite) {
            const existing = allSnap.find(s => s.id === key);
            const existingRemark = (existing?.remark || '').trim();
            const newRemark = existingRemark ? `${existingRemark} ${remarkVal}` : remarkVal;
            ipSegmentStorage.update(key, { ...updateData, remark: newRemark });
          } else {
            ipSegmentStorage.update(key, updateData);
          }
          successCount++;
        } catch (e) {
          console.error('批量更新失败:', key, e);
        }
      });

      if (successCount > 0) {
        message.success(`成功更新 ${successCount} 条记录`);
        setBatchEditVisible(false);
        batchEditForm.resetFields();
        setSelectedRowKeys([]);
        loadData();
        saveDataToFile(true);
      }
    } catch (e) {
      console.error('批量编辑失败:', e);
    }
  };

  const handleBatchToggleInUse = (inUse: boolean) => {
    let count = 0;
    selectedRowKeys.forEach(key => {
      try {
        ipSegmentStorage.update(key, { gttInUse: inUse });
        count++;
      } catch { /* skip */ }
    });
    if (count > 0) {
      message.success(`已将 ${count} 个 IP 段设为${inUse ? '在用' : '未使用'}`);
      setSelectedRowKeys([]);
      loadData();
      saveDataToFile(true);
    }
  };

  const handleBatchStar = (star: boolean) => {
    let count = 0;
    selectedRowKeys.forEach(key => {
      try {
        ipSegmentStorage.update(key, { ispStarred: star });
        count++;
      } catch { /* skip */ }
    });
    if (count > 0) {
      message.success(`已${star ? '添加' : '取消'} ${count} 个 IP 段的星标`);
      setSelectedRowKeys([]);
      loadData();
      saveDataToFile(true);
    }
  };

  const handleBatchCopy = () => {
    const segments = ipSegments.filter(s => selectedRowKeys.includes(s.id));
    const text = segments.map(s => s.segment).join('\n');
    navigator.clipboard.writeText(text).then(() => {
      message.success(`已复制 ${segments.length} 个 IP 段到剪贴板`);
    }).catch(() => {
      message.error('复制失败');
    });
  };

  // ── 表格列 ──

  const columns: ColumnsType<IPSegment> = [
    {
      title: '',
      dataIndex: 'ispStarred',
      key: 'star',
      width: 40,
      fixed: 'left',
      render: (_: any, record: IPSegment) => (
        <span
          style={{ cursor: 'pointer', fontSize: 16 }}
          onClick={(e) => {
            e.stopPropagation();
            if (record.ispStarred) {
              setUnstarConfirmId(record.id);
            } else {
              handleStarToggle(record);
            }
          }}
        >
          {record.ispStarred ? <StarFilled style={{ color: '#faad14' }} /> : <StarOutlined style={{ color: '#d9d9d9' }} />}
        </span>
      ),
    },
    {
      title: 'IP段',
      dataIndex: 'segment',
      key: 'segment',
      width: 160,
      fixed: 'left',
      sorter: (a, b) => a.segment.localeCompare(b.segment),
      render: (text: string) => <Text strong style={{ fontFamily: 'monospace', fontSize: 13 }}>{text}</Text>,
    },
    {
      title: '供应商',
      dataIndex: 'supplier',
      key: 'supplier',
      width: 100,
      filters: [...new Set(gttSegments.map(s => s.supplier))].map(s => ({ text: s, value: s })),
      onFilter: (value, record) => record.supplier === value,
      render: (text: string) => <Tag color={SUPPLIER_COLOR_MAP[text] || 'default'}>{text}</Tag>,
    },
    {
      title: 'ASN',
      dataIndex: 'asn',
      key: 'asn',
      width: 100,
      render: (text: string) => text || '-',
    },
    {
      title: '宣告地区',
      dataIndex: 'usageArea',
      key: 'usageArea',
      width: 130,
      filters: [...new Set(gttSegments.map(s => s.usageArea).filter(Boolean))].map(a => ({ text: a, value: a })),
      onFilter: (value, record) => record.usageArea === value,
    },
    {
      title: '用户',
      dataIndex: 'ispUser',
      key: 'ispUser',
      width: 120,
      filters: [...new Set(gttSegments.map(s => s.ispUser).filter(Boolean))].map(u => ({ text: u!, value: u! })),
      onFilter: (value, record) => record.ispUser === value,
      render: (text: string, record: IPSegment) => {
        if (canEdit && editingUserId === record.id) {
          return (
            <Input
              size="small"
              autoFocus
              value={editingUserValue}
              onChange={e => setEditingUserValue(e.target.value)}
              onPressEnter={saveUserInline}
              onBlur={saveUserInline}
              style={{ width: '100%' }}
              placeholder="输入用户"
            />
          );
        }
        return (
          <div
            style={{ cursor: canEdit ? 'pointer' : 'default', display: 'flex', alignItems: 'center', gap: 4, minHeight: 22 }}
            onClick={() => canEdit && startUserEdit(record)}
          >
            {text ? (
              <Tag color="blue" style={{ margin: 0 }}>{text}</Tag>
            ) : (
              <Text type="secondary" style={{ fontSize: 12 }}>{canEdit ? '点击输入' : '-'}</Text>
            )}
            {canEdit && <EditOutlined style={{ color: '#999', fontSize: 12 }} />}
          </div>
        );
      },
    },
    {
      title: '购买时间',
      dataIndex: 'purchaseDate',
      key: 'purchaseDate',
      width: 110,
      sorter: (a, b) => (a.purchaseDate || '').localeCompare(b.purchaseDate || ''),
      render: (d: string) => d ? dayjs(d).format('YYYY-MM-DD') : '-',
    },
    {
      title: '费用($)',
      dataIndex: 'monthlyPrice',
      key: 'monthlyPrice',
      width: 90,
      sorter: (a, b) => (a.monthlyPrice || 0) - (b.monthlyPrice || 0),
      render: (v: number) => v ? `$${v.toFixed(2)}` : '-',
    },
    {
      title: '使用方式',
      dataIndex: 'usageMethod',
      key: 'usageMethod',
      width: 180,
      render: (text: string, record: IPSegment) => {
        if (canEdit && editingUsageId === record.id) {
          return (
            <Input
              size="small"
              autoFocus
              value={editingUsageValue}
              onChange={e => setEditingUsageValue(e.target.value)}
              onPressEnter={saveUsageInline}
              onBlur={saveUsageInline}
              style={{ width: '100%' }}
              placeholder="输入使用方式"
            />
          );
        }
        return (
          <div
            style={{ cursor: canEdit ? 'pointer' : 'default', display: 'flex', alignItems: 'center', gap: 4, minHeight: 22 }}
            onClick={() => canEdit && startUsageEdit(record)}
          >
            {text ? (
              <Tooltip title={text}>
                <span style={{ maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'inline-block' }}>{text}</span>
              </Tooltip>
            ) : (
              <Text type="secondary" style={{ fontSize: 12 }}>{canEdit ? '点击输入' : '-'}</Text>
            )}
            {canEdit && <EditOutlined style={{ color: '#999', fontSize: 12 }} />}
          </div>
        );
      },
    },
    {
      title: '是否在用',
      dataIndex: 'gttInUse',
      key: 'gttInUse',
      width: 90,
      filters: [
        { text: '在用', value: 'active' },
        { text: '未使用', value: 'unused' },
        { text: '已取消', value: 'cancelled' },
      ],
      onFilter: (value, record) => {
        if (value === 'cancelled') return isCancelled(record);
        if (value === 'unused') return !isCancelled(record) && record.gttInUse === false;
        return !isCancelled(record) && record.gttInUse !== false;
      },
      render: (val: boolean | undefined, record: IPSegment) => {
        if (isCancelled(record)) return <Tag color="default">已取消</Tag>;
        const inUse = val !== false;
        return (
          <Tag
            color={inUse ? 'success' : 'default'}
            style={canEdit ? { cursor: 'pointer' } : undefined}
            onClick={canEdit ? () => handleInUseToggle(record, !inUse) : undefined}
          >
            {inUse ? '在用' : '未使用'}
          </Tag>
        );
      },
    },
    {
      title: '备注',
      dataIndex: 'remark',
      key: 'remark',
      width: 150,
      render: (text: string, record: IPSegment) => {
        if (canEdit && editingRemarkId === record.id) {
          return (
            <Input
              size="small"
              autoFocus
              value={editingRemarkValue}
              onChange={e => setEditingRemarkValue(e.target.value)}
              onPressEnter={saveRemarkInline}
              onBlur={saveRemarkInline}
              style={{ width: '100%' }}
              placeholder="输入备注"
            />
          );
        }
        return (
          <div
            style={{ cursor: canEdit ? 'pointer' : 'default', display: 'flex', alignItems: 'center', gap: 4, minHeight: 22 }}
            onClick={() => canEdit && startRemarkEdit(record)}
          >
            {text ? (
              <Tooltip title={text}>
                <span style={{ maxWidth: 110, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'inline-block' }}>{text}</span>
              </Tooltip>
            ) : (
              <Text type="secondary" style={{ fontSize: 12 }}>{canEdit ? '点击输入' : '-'}</Text>
            )}
            {canEdit && <EditOutlined style={{ color: '#999', fontSize: 12 }} />}
          </div>
        );
      },
    },
    ...(canEdit ? [{
      title: '操作',
      key: 'action',
      width: 80,
      fixed: 'right' as const,
      render: (_: any, record: IPSegment) => (
        record.supplier !== 'GTT' ? (
          <Popconfirm title="确定将此 IP 段移出 ISP 管理？" onConfirm={() => handleRemove(record.id)} okText="确定" cancelText="取消">
            <Button type="link" size="small" danger icon={<DeleteOutlined />}>移出</Button>
          </Popconfirm>
        ) : null
      ),
    }] : []),
  ];

  const addColumns: ColumnsType<IPSegment> = [
    { title: 'IP段', dataIndex: 'segment', key: 'segment', width: 160, render: (t: string) => <Text style={{ fontFamily: 'monospace' }}>{t}</Text> },
    { title: '供应商', dataIndex: 'supplier', key: 'supplier', width: 100, render: (t: string) => <Tag color={SUPPLIER_COLOR_MAP[t] || 'default'}>{t}</Tag> },
    { title: 'ASN', dataIndex: 'asn', key: 'asn', width: 90 },
    { title: '宣告地区', dataIndex: 'usageArea', key: 'usageArea', width: 120 },
    { title: '用户', dataIndex: 'ispUser', key: 'ispUser', width: 100, render: (t: string) => t ? <Tag color="blue">{t}</Tag> : '-' },
  ];

  const renderTable = (data: IPSegment[]) => (
    <Table
      columns={columns}
      dataSource={data}
      rowKey="id"
      size="small"
      scroll={{ x: 1350, y: 'calc(100vh - 380px)' }}
      pagination={false}
      rowSelection={canEdit ? {
        columnWidth: 46,
        selectedRowKeys,
        onChange: (keys) => setSelectedRowKeys(keys as string[]),
      } : undefined}
      rowClassName={(record) => record.ispStarred ? 'isp-starred-row' : ''}
    />
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <style>{`
        .isp-starred-row td { background: #fffbe6 !important; }
        .isp-starred-row:hover td { background: #fff1b8 !important; }
      `}</style>
      <Row gutter={[12, 12]}>
        {([
          { title: 'ISP 管理总数', value: gttSegments.length, color: undefined, byCountry: totalByCountry, bySupplier: totalBySupplier },
          { title: '在用', value: activeSegments.length, color: '#52c41a', byCountry: activeByCountry, bySupplier: activeBySupplier },
          { title: '未使用', value: unusedSegments.length, color: '#faad14', byCountry: unusedByCountry, bySupplier: unusedBySupplier },
          { title: '已取消', value: cancelledSegments.length, color: '#ff4d4f', byCountry: [] as [string, number][], bySupplier: [] as [string, number][] },
        ] as const).map(item => (
          <Col span={6} key={item.title}>
            <Card size="small" bodyStyle={{ padding: '12px 14px' }}>
              <Statistic title={item.title} value={item.value} valueStyle={item.color ? { color: item.color } : undefined} />
              {(item.byCountry.length > 0 || item.bySupplier.length > 0) && (
                <div style={{ marginTop: 6, display: 'flex', gap: 6 }}>
                  {item.byCountry.length > 0 && (
                    <div style={{ flex: 1, background: '#fafafa', borderRadius: 4, padding: '3px 6px' }}>
                      <Text type="secondary" style={{ fontSize: 10, fontWeight: 500 }}>按国家</Text>
                      <div style={{ marginTop: 1 }}>
                        {item.byCountry.map(([k, v]) => (
                          <div key={k} style={{ display: 'flex', gap: 4, fontSize: 11, color: '#333', lineHeight: '16px' }}>
                            <span>{k}</span>
                            <span style={{ fontWeight: 500, color: item.color || '#1677ff' }}>{v}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  {item.bySupplier.length > 0 && (
                    <div style={{ flex: 1, background: '#fafafa', borderRadius: 4, padding: '3px 6px' }}>
                      <Text type="secondary" style={{ fontSize: 10, fontWeight: 500 }}>按供应商</Text>
                      <div style={{ marginTop: 1 }}>
                        {item.bySupplier.map(([k, v]) => (
                          <div key={k} style={{ display: 'flex', gap: 4, fontSize: 11, color: '#333', lineHeight: '16px' }}>
                            <span>{k}</span>
                            <span style={{ fontWeight: 500, color: item.color || '#1677ff' }}>{v}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </Card>
          </Col>
        ))}
      </Row>

      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
        <Input.TextArea
          placeholder="搜索 IP段 / 供应商 / ASN / 使用方式（多个用空格、逗号或换行分隔）"
          value={searchText}
          onChange={e => setSearchText(e.target.value)}
          allowClear
          autoSize={{ minRows: 1, maxRows: 4 }}
          style={{ width: 400 }}
        />
        {canEdit && (
          <Button type="primary" icon={<PlusOutlined />} onClick={() => { setAddModalOpen(true); setAddSelectedKeys([]); setAddSearch(''); }}>
            手动添加 IP 段
          </Button>
        )}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <Text type="secondary" style={{ fontSize: 13 }}>
          当前显示 <Text strong style={{ fontSize: 13 }}>{filteredStats.total}</Text> 条
        </Text>
        <Tag color="success" style={{ margin: 0 }}>在用 {filteredStats.inUse}</Tag>
        <Tag color="default" style={{ margin: 0 }}>未使用 {filteredStats.unused}</Tag>
        {filteredStats.cancelled > 0 && <Tag color="error" style={{ margin: 0 }}>已取消 {filteredStats.cancelled}</Tag>}
      </div>

      {/* 批量操作工具栏 */}
      {canEdit && selectedRowKeys.length > 0 && (
        <div style={{ background: '#e6f7ff', border: '1px solid #91d5ff', borderRadius: 6, padding: '8px 16px', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <Text strong>已选择 {selectedRowKeys.length} 项</Text>
          <Button type="primary" size="small" onClick={() => { setBatchEditVisible(true); batchEditForm.resetFields(); }}>
            批量编辑
          </Button>
          <Button size="small" icon={<CopyOutlined />} onClick={handleBatchCopy}>批量复制</Button>
          <Popconfirm title={`确定将选中的 ${selectedRowKeys.length} 个 IP 段设为在用？`} onConfirm={() => handleBatchToggleInUse(true)} okText="确定" cancelText="取消">
            <Button size="small" icon={<CheckOutlined />}>批量设为在用</Button>
          </Popconfirm>
          <Popconfirm title={`确定将选中的 ${selectedRowKeys.length} 个 IP 段设为未使用？`} onConfirm={() => handleBatchToggleInUse(false)} okText="确定" cancelText="取消">
            <Button size="small" icon={<CloseOutlined />}>批量设为未使用</Button>
          </Popconfirm>
          <Button size="small" onClick={() => setSelectedRowKeys([])}>取消选择</Button>
        </div>
      )}

      <Tabs
        activeKey={activeTab}
        onChange={handleTabChange}
        items={[
          { key: 'all', label: `全部IP段 (${searchText ? `${displayAll.length}/` : ''}${gttSegments.length})`, children: renderTable(displayAll) },
          { key: 'active', label: `在用IP段 (${searchText ? `${displayActive.length}/` : ''}${activeSegments.length})`, children: renderTable(displayActive) },
          { key: 'unused', label: `未使用IP段 (${searchText ? `${displayUnused.length}/` : ''}${unusedSegments.length})`, children: renderTable(displayUnused) },
          { key: 'cancelled', label: `已取消IP段 (${searchText ? `${displayCancelled.length}/` : ''}${cancelledSegments.length})`, children: renderTable(displayCancelled) },
        ]}
      />

      {/* 手动添加 Modal */}
      <Modal
        title="手动添加 IP 段到 ISP 管理"
        open={addModalOpen}
        onOk={handleAddConfirm}
        onCancel={() => setAddModalOpen(false)}
        okText={`添加 (${addSelectedKeys.length})`}
        cancelText="取消"
        width={800}
        destroyOnClose
      >
        <div style={{ marginBottom: 12 }}>
          <Input.TextArea
            placeholder="搜索 IP段 / 供应商 / ASN（多个用空格、逗号或换行分隔）"
            value={addSearch}
            onChange={e => setAddSearch(e.target.value)}
            allowClear
            autoSize={{ minRows: 1, maxRows: 4 }}
          />
        </div>
        <Table
          columns={addColumns}
          dataSource={nonGttSegments}
          rowKey="id"
          size="small"
          scroll={{ y: 400 }}
          pagination={{ pageSize: 50, showSizeChanger: true, showTotal: (t) => `共 ${t} 条` }}
          rowSelection={{
            selectedRowKeys: addSelectedKeys,
            onChange: (keys) => setAddSelectedKeys(keys as string[]),
          }}
        />
      </Modal>

      {/* 批量编辑 Modal */}
      <Modal
        title={`批量编辑 (已选择 ${selectedRowKeys.length} 条)`}
        open={batchEditVisible}
        onOk={handleBatchEditSubmit}
        onCancel={() => { setBatchEditVisible(false); batchEditForm.resetFields(); }}
        okText="批量更新"
        cancelText="取消"
        width={600}
        destroyOnClose
      >
        <Text type="secondary" style={{ display: 'block', marginBottom: 16 }}>
          只填写需要批量修改的字段，留空的字段将保持不变
        </Text>
        <Form form={batchEditForm} layout="vertical">
          <Form.Item name="ispUser" label="用户">
            <Input placeholder="留空则不修改" maxLength={100} />
          </Form.Item>
          <Form.Item name="usageMethod" label="使用方式">
            <Input.TextArea placeholder="留空则不修改" rows={2} maxLength={500} showCount />
          </Form.Item>
          <Form.Item name="gttInUse" label="是否在用">
            <Select allowClear placeholder="留空则不修改">
              <Select.Option value={true}>在用</Select.Option>
              <Select.Option value={false}>未使用</Select.Option>
            </Select>
          </Form.Item>
          <Form.Item name="ispStarred" label="星标">
            <Select allowClear placeholder="留空则不修改">
              <Select.Option value={true}>添加星标</Select.Option>
              <Select.Option value={false}>取消星标</Select.Option>
            </Select>
          </Form.Item>
          <Form.Item label="备注">
            <Space direction="vertical" style={{ width: '100%' }}>
              <Form.Item name="remark" noStyle>
                <Input.TextArea placeholder="留空则不修改" rows={2} maxLength={500} showCount />
              </Form.Item>
              <Form.Item name="remarkOverwrite" valuePropName="checked" noStyle>
                <Checkbox>覆盖原备注（不勾选则追加）</Checkbox>
              </Form.Item>
            </Space>
          </Form.Item>
        </Form>
      </Modal>

      {/* 取消星标确认 */}
      <Modal
        title="取消星标"
        open={!!unstarConfirmId}
        onOk={() => {
          if (unstarConfirmId) {
            const seg = ipSegments.find(s => s.id === unstarConfirmId);
            if (seg) handleStarToggle(seg);
          }
          setUnstarConfirmId(null);
        }}
        onCancel={() => setUnstarConfirmId(null)}
        okText="确定"
        cancelText="取消"
        width={300}
      >
        <p>确定取消该 IP 段的星标？</p>
      </Modal>
    </div>
  );
};

export default IspManagement;

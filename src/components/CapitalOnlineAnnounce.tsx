import React, { useEffect, useRef, useState, useCallback } from 'react';
import { Alert, Spin, Typography, Tabs, Result, Select, Button, Space, Tag, message } from 'antd';
import { LockOutlined, SoundOutlined, StopOutlined, UnorderedListOutlined, FileTextOutlined, DownloadOutlined, SendOutlined } from '@ant-design/icons';
import { useAuth } from '../contexts/AuthContext';

const { Text } = Typography;

interface LarusAllocation { asn: string; loa_path: string | null; alloc_id: number; }
interface LarusItem { id: number; ip_cidr: string; asn?: string; loa_path?: string; allocations?: LarusAllocation[]; }

const CDS_PAGES = [
  { key: 'announce',     label: '批量宣告',     icon: <SoundOutlined />,         path: '/cds-proxy/',              adminOnly: false },
  { key: 'withdraw',     label: '批量撤播',     icon: <StopOutlined />,          path: '/cds-proxy/withdraw',      adminOnly: true  },
  { key: 'announced',   label: '已宣告 IP 段', icon: <UnorderedListOutlined />, path: '/cds-proxy/announced',     adminOnly: false },
  { key: 'loa-manager', label: 'LOA 管理',     icon: <FileTextOutlined />,      path: '/cds-proxy/loa-manager',   adminOnly: false },
];

/**
 * 首都在线宣告页面
 * 通过 /cds-proxy 代理访问 CDS-Auto-Announce Flask 服务（端口 9010）。
 * 主系统 token 通过代理层转换为内部 token，Flask 自动以 admin 身份信任。
 * 顶部导航由本组件提供，Flask 自身导航栏会被隐藏。
 */
const CapitalOnlineAnnounce: React.FC = () => {
  const { hasPermission } = useAuth();
  const canWithdraw = hasPermission('announce-capital-online.withdraw');
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [status, setStatus] = useState<'loading' | 'ok' | 'error'>('loading');
  const [errMsg, setErrMsg] = useState('');
  const [activeTab, setActiveTab] = useState('announce');

  // Larus LOA picker 状态
  const [larusItems, setLarusItems] = useState<LarusItem[]>([]);
  const [selectedCidr, setSelectedCidr] = useState<string>('');
  const [selectedAlloc, setSelectedAlloc] = useState<string>(''); // "asn|loa_path"
  const [pushing, setPushing] = useState(false);

  useEffect(() => {
    fetch('/api/larus/ips').then(r => r.json()).then(d => {
      if (d.success) setLarusItems(d.items || []);
    }).catch(() => {});
  }, []);

  const selectedItem = larusItems.find(it => it.ip_cidr === selectedCidr);
  const allocOptions = (() => {
    if (!selectedItem) return [];
    if (selectedItem.allocations?.length) {
      return selectedItem.allocations
        .filter(a => a.loa_path)
        .map(a => ({ label: `AS${a.asn}`, value: `${a.asn}|${a.loa_path}` }));
    }
    if (selectedItem.loa_path) {
      return [{ label: `AS${selectedItem.asn || '—'}`, value: `${selectedItem.asn || ''}|${selectedItem.loa_path}` }];
    }
    return [];
  })();

  const pushLoa = async () => {
    if (!selectedCidr || !selectedAlloc) return;
    const [asn, loa_path] = selectedAlloc.split('|');
    setPushing(true);
    try {
      const res = await fetch('/api/larus/loa-to-cds', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cidr: selectedCidr, asn, loa_path }),
      });
      const data = await res.json();
      if (data.success) {
        message.success('LOA 已推送至首都在线宣告系统');
      } else {
        message.error(data.message || '推送失败');
      }
    } catch (e: any) {
      message.error(e.message || '推送失败');
    } finally {
      setPushing(false);
    }
  };

  // 检查 CDS 服务是否可用
  useEffect(() => {
    fetch('/cds-proxy/', { redirect: 'manual' })
      .then(r => {
        if (r.ok || r.status === 302 || r.type === 'opaqueredirect') {
          setStatus('ok');
        } else {
          setErrMsg(`服务响应异常 (${r.status})`);
          setStatus('error');
        }
      })
      .catch(e => {
        setErrMsg(e.message || '无法连接首都在线宣告服务');
        setStatus('error');
      });
  }, []);

  // iframe 加载后注入 CSS 隐藏 Flask 原有导航栏
  const handleLoad = useCallback(() => {
    try {
      const doc = iframeRef.current?.contentDocument;
      if (doc) {
        const existing = doc.getElementById('__cds_hide_nav__');
        if (existing) return;
        const style = doc.createElement('style');
        style.id = '__cds_hide_nav__';
        style.textContent = `
          .nav { display: none !important; }
          .topbar { padding-top: 4px !important; }
          .wrap { padding-top: 12px !important; }
        `;
        doc.head?.appendChild(style);
      }
    } catch {
      // 跨域时无法操作，忽略
    }
  }, []);

  const currentPage = CDS_PAGES.find(p => p.key === activeTab) ?? CDS_PAGES[0];

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: 'calc(100vh - 96px)',
      background: '#fff',
      borderRadius: 8,
      boxShadow: '0 1px 4px rgba(0,0,0,0.06)',
      overflow: 'hidden',
    }}>
      {/* 顶部导航 Tab */}
      <div style={{ borderBottom: '1px solid #f0f0f0', padding: '0 16px', flexShrink: 0 }}>
        <Tabs
          activeKey={activeTab}
          onChange={key => setActiveTab(key)}
          size="small"
          style={{ marginBottom: 0 }}
          items={CDS_PAGES.map(p => ({
            key: p.key,
            label: <span>{p.icon} {p.label}</span>,
          }))}
        />
      </div>

      {/* 内容区 */}
      {status === 'loading' && (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Spin tip="加载首都在线宣告服务..." size="large" />
        </div>
      )}

      {status === 'error' && (
        <div style={{ padding: 24 }}>
          <Alert
            type="error"
            showIcon
            message="首都在线宣告服务未启动"
            description={
              <div>
                <div>{errMsg}</div>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  请确认 cds-config.json 已配置且 CDS-Auto-Announce Flask 服务在端口 9010 运行。
                </Text>
              </div>
            }
          />
        </div>
      )}

      {status === 'ok' && (
        currentPage.adminOnly && !canWithdraw ? (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Result
              icon={<LockOutlined style={{ color: '#faad14' }} />}
              title="权限不足"
              subTitle="您没有批量撤播权限"
            />
          </div>
        ) : (
          <>
            {activeTab === 'announce' && larusItems.length > 0 && (
              <div style={{
                padding: '8px 16px',
                borderBottom: '1px solid #f0f0f0',
                background: '#fafafa',
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                flexWrap: 'wrap',
                flexShrink: 0,
              }}>
                <Text type="secondary" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>Larus LOA：</Text>
                <Select
                  showSearch
                  placeholder="选择 IP 段"
                  style={{ width: 200 }}
                  size="small"
                  allowClear
                  value={selectedCidr || undefined}
                  onChange={v => { setSelectedCidr(v || ''); setSelectedAlloc(''); }}
                  options={larusItems.map(it => ({ label: it.ip_cidr, value: it.ip_cidr }))}
                  filterOption={(input, opt) => (opt?.label as string || '').includes(input)}
                />
                {selectedItem && allocOptions.length === 0 && (
                  <Tag color="warning">该 IP 段无 LOA（可先在 Larus 管理页获取）</Tag>
                )}
                {allocOptions.length > 0 && (
                  <Select
                    placeholder="选择 ASN"
                    style={{ width: 130 }}
                    size="small"
                    value={selectedAlloc || undefined}
                    onChange={v => setSelectedAlloc(v)}
                    options={allocOptions}
                  />
                )}
                {selectedAlloc && (
                  <>
                    <Button
                      size="small"
                      icon={<DownloadOutlined />}
                      onClick={() => {
                        const lp = selectedAlloc.split('|')[1];
                        if (lp) window.open(`/api/larus/loa?path=${encodeURIComponent(lp)}`, '_blank');
                      }}
                    >
                      下载 LOA
                    </Button>
                    <Button
                      size="small"
                      type="primary"
                      icon={<SendOutlined />}
                      loading={pushing}
                      onClick={pushLoa}
                    >
                      推送至首都在线
                    </Button>
                  </>
                )}
              </div>
            )}
            <iframe
              key={currentPage.path}
              ref={iframeRef}
              src={currentPage.path}
              style={{ flex: 1, border: 'none', width: '100%' }}
              title={currentPage.label}
              onLoad={handleLoad}
            />
          </>
        )
      )}
    </div>
  );
};

export default CapitalOnlineAnnounce;

import React, { useEffect, useRef, useState, useCallback } from 'react';
import { Alert, Spin, Typography, Tabs } from 'antd';
import {
  SoundOutlined, StopOutlined, UnorderedListOutlined,
} from '@ant-design/icons';

const { Text } = Typography;

const CDS_PAGES = [
  { key: 'announce',  label: '批量宣告',     icon: <SoundOutlined />,         path: '/cds-proxy/' },
  { key: 'withdraw',  label: '批量撤播',     icon: <StopOutlined />,          path: '/cds-proxy/withdraw' },
  { key: 'announced', label: '已宣告 IP 段', icon: <UnorderedListOutlined />, path: '/cds-proxy/announced' },
];

/**
 * 首都在线宣告页面
 * 通过 /cds-proxy 代理访问 CDS-Auto-Announce Flask 服务（端口 9010）。
 * 主系统 token 通过代理层转换为内部 token，Flask 自动以 admin 身份信任。
 * 顶部导航由本组件提供，Flask 自身导航栏会被隐藏。
 */
const CapitalOnlineAnnounce: React.FC = () => {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [status, setStatus] = useState<'loading' | 'ok' | 'error'>('loading');
  const [errMsg, setErrMsg] = useState('');
  const [activeTab, setActiveTab] = useState('announce');

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
        <iframe
          key={currentPage.path}   // key 变化时强制刷新 iframe
          ref={iframeRef}
          src={currentPage.path}
          style={{ flex: 1, border: 'none', width: '100%' }}
          title={currentPage.label}
          onLoad={handleLoad}
        />
      )}
    </div>
  );
};

export default CapitalOnlineAnnounce;

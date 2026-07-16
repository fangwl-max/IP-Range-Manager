import React, { useState, useEffect, useLayoutEffect } from 'react';
import { App as AntdApp, ConfigProvider, Layout, Menu, Button, Spin, Modal } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import {
  DatabaseOutlined,
  BarChartOutlined,
  SettingOutlined,
  SearchOutlined,
  UserOutlined,
  LogoutOutlined,
  TeamOutlined,
  ShopOutlined,
  GlobalOutlined,
  NumberOutlined,
  MailOutlined,
  SafetyCertificateOutlined,
  StarOutlined,
  SoundOutlined,
} from '@ant-design/icons';
import type { MenuProps } from 'antd';
import './App.css';
import IPManagement from './components/IPManagement';
import CostAnalysis from './components/CostAnalysis';
import ProjectGroupConfigPage from './components/config/ProjectGroupConfigPage';
import SupplierConfigPage from './components/config/SupplierConfigPage';
import UsageAreaConfigPage from './components/config/UsageAreaConfigPage';
import AsnConfigPage from './components/config/AsnConfigPage';
import IRRDetection from './components/IRRDetection';
import UserManagement from './components/UserManagement';
import Login from './components/Login';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import IPXOBilling from './components/IPXOBilling';
import NotifyConfig from './components/NotifyConfig';
import AsnStandbyPage from './components/AsnStandbyPage';
import IPSegmentStats from './components/IPSegmentStats';
import PrePurchaseCheck from './components/PrePurchaseCheck';
import ZenAnnounce from './components/ZenAnnounce';
import CapitalOnlineAnnounce from './components/CapitalOnlineAnnounce';

const { Sider, Content } = Layout;

const ROLE_LABELS: Record<string, string> = {
  admin: '系统管理员',
  editor: '编辑者',
  viewer: '查看者',
};

const SELECTED_MENU_KEY = 'ip-management-platform-selected-menu';
const CONFIG_SUB_KEYS = [
  'config-project-groups',
  'config-suppliers',
  'config-usage-areas',
] as const;
const ASN_SUB_KEYS = [
  'asn-management',
  'asn-standby-a',
  'asn-standby-b',
] as const;
const ANNOUNCE_SUB_KEYS = [
  'announce-zen',
  'announce-capital-online',
] as const;
const VALID_MENU_KEYS = [
  'ip-management',
  'irr-detection',
  'cost-analysis-main',
  'cost-analysis-ipxo',
  'ip-segment-stats',
  ...CONFIG_SUB_KEYS,
  ...ASN_SUB_KEYS,
  ...ANNOUNCE_SUB_KEYS,
  'user-management',
  'notify-config',
  'pre-purchase-check',
] as const;
const isConfigSubKey = (k: string) => CONFIG_SUB_KEYS.includes(k as (typeof CONFIG_SUB_KEYS)[number]);
const isAsnSubKey = (k: string) => ASN_SUB_KEYS.includes(k as (typeof ASN_SUB_KEYS)[number]);
const isAnnounceSubKey = (k: string) => ANNOUNCE_SUB_KEYS.includes(k as (typeof ANNOUNCE_SUB_KEYS)[number]);

const AppContent: React.FC = () => {
  const { user, logout, loading, hasPermission } = useAuth();
  const [selectedMenu, setSelectedMenu] = useState<string>(() => {
    const saved = localStorage.getItem(SELECTED_MENU_KEY);
    if (saved === 'gateway-ping') return 'irr-detection';
    if (saved === 'configuration') return 'config-project-groups';
    if (saved === 'cost-analysis') return 'cost-analysis-main';
    if (saved && (VALID_MENU_KEYS as readonly string[]).includes(saved)) return saved;
    return 'ip-management';
  });

  const [menuOpenKeys, setMenuOpenKeys] = useState<string[]>(() => {
    const s = localStorage.getItem(SELECTED_MENU_KEY);
    const o: string[] = [];
    if (s && (s === 'configuration' || isConfigSubKey(s))) o.push('configuration');
    if (s === 'irr-detection') o.push('ip-detection');
    if (s === 'cost-analysis-main' || s === 'cost-analysis-ipxo') o.push('cost-analysis');
    if (s && isAsnSubKey(s)) o.push('asn');
    if (s && isAnnounceSubKey(s)) o.push('announce');
    return o;
  });

  useEffect(() => {
    localStorage.setItem(SELECTED_MENU_KEY, selectedMenu);
  }, [selectedMenu]);

  useEffect(() => {
    setMenuOpenKeys((k) => {
      let n = [...k];
      if (selectedMenu.startsWith('config-') || isConfigSubKey(selectedMenu)) {
        if (!n.includes('configuration')) n.push('configuration');
      } else {
        n = n.filter((x) => x !== 'configuration');
      }
      if (selectedMenu === 'irr-detection' || selectedMenu === 'pre-purchase-check') {
        if (!n.includes('ip-detection')) n.push('ip-detection');
      } else {
        n = n.filter((x) => x !== 'ip-detection');
      }
      if (selectedMenu === 'cost-analysis-main' || selectedMenu === 'cost-analysis-ipxo') {
        if (!n.includes('cost-analysis')) n.push('cost-analysis');
      } else {
        n = n.filter((x) => x !== 'cost-analysis');
      }
      if (isAsnSubKey(selectedMenu)) {
        if (!n.includes('asn')) n.push('asn');
      } else {
        n = n.filter((x) => x !== 'asn');
      }
      if (isAnnounceSubKey(selectedMenu)) {
        if (!n.includes('announce')) n.push('announce');
      } else {
        n = n.filter((x) => x !== 'announce');
      }
      return n;
    });
  }, [selectedMenu]);

  // 上次选中的「用户与权限」在降权或无权限时会导致主内容区无任何页面，表现为白屏
  useEffect(() => {
    if (!user) return;
    if (selectedMenu === 'user-management' && !hasPermission('manage_users')) {
      setSelectedMenu('ip-management');
    }
  }, [user, selectedMenu, hasPermission]);

  // 挂载全局导航函数，供子组件跨层跳转菜单
  useEffect(() => {
    (window as any).__navigateTo = (key: string) => setSelectedMenu(key);
    return () => { delete (window as any).__navigateTo; };
  }, []);

  // 仅清理 Modal 与 body 滚动锁。勿调用 message.destroy()/notification.destroy()：会与 antd 5 的 <App> 共用容器，销毁后整树白屏。
  useLayoutEffect(() => {
    if (loading) return;
    Modal.destroyAll();
    document.body.style.overflow = '';
    document.body.style.removeProperty('padding-right');
  }, [loading, user]);

  const menuItems: MenuProps['items'] = [
    { key: 'ip-management', icon: <DatabaseOutlined />, label: 'IP段管理' },
    {
      key: 'ip-detection',
      icon: <SearchOutlined />,
      label: 'IP段检测',
      children: [
        { key: 'irr-detection', label: '综合检测' },
        ...(user?.role === 'admin' ? [{ key: 'pre-purchase-check', label: '购前检测' }] : []),
      ],
    },
    { key: 'cost-analysis', icon: <BarChartOutlined />, label: '费用统计',
      children: [
        { key: 'cost-analysis-main', label: '费用分析' },
        { key: 'cost-analysis-ipxo', label: 'IPXO 账单' },
        { key: 'ip-segment-stats', label: 'IP 段统计' },
      ],
    },
    {
      key: 'configuration',
      icon: <SettingOutlined />,
      label: '配置管理',
      children: [
        { key: 'config-project-groups', icon: <TeamOutlined />, label: '项目组' },
        { key: 'config-suppliers', icon: <ShopOutlined />, label: '供应商' },
        { key: 'config-usage-areas', icon: <GlobalOutlined />, label: '使用地区' },
      ],
    },
    {
      key: 'asn',
      icon: <SafetyCertificateOutlined />,
      label: 'ASN',
      children: [
        { key: 'asn-management', icon: <NumberOutlined />, label: 'ASN 管理' },
        { key: 'asn-standby-a', icon: <StarOutlined />, label: 'A 组备用 AS' },
        { key: 'asn-standby-b', icon: <StarOutlined />, label: 'B 组备用 AS' },
      ],
    },
    ...(hasPermission('manage_users') ? [{ key: 'user-management', icon: <UserOutlined />, label: '用户与权限' }] : []),
    { key: 'notify-config', icon: <MailOutlined />, label: '通知配置' },
    {
      key: 'announce',
      icon: <SoundOutlined />,
      label: 'IP段宣告',
      children: [
        { key: 'announce-zen', label: 'Zenlayer 宣告' },
        { key: 'announce-capital-online', label: '首都在线宣告' },
      ],
    },
  ];

  if (loading) {
    return (
      <div
        style={{
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          minHeight: '100vh',
          background: '#f0f2f5',
        }}
      >
        <Spin size="large" />
      </div>
    );
  }

  if (!user) {
    return <Login />;
  }

  const displayName = user.displayName || user.username;
  const avatarLetter = (displayName.charAt(0) || '?').toUpperCase();
  const roleLabel = ROLE_LABELS[user.role] || user.role;

  return (
    <Layout style={{ minHeight: '100vh', display: 'flex' }}>
      <Sider
        width={200}
        style={{
          height: '100vh',
          position: 'fixed',
          left: 0,
          top: 0,
          bottom: 0,
          overflow: 'hidden',
        }}
      >
        {/* ant-layout-sider 会把子节点包一层，flex 需写在内层才能撑满并固定底部账户区 */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            height: '100%',
            minHeight: 0,
          }}
        >
        <div style={{ padding: '16px', color: '#fff', fontSize: '18px', fontWeight: 'bold', textAlign: 'center', flexShrink: 0 }}>
          IP段管理平台
        </div>
        <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
          <Menu
            theme="dark"
            mode="inline"
            selectedKeys={[selectedMenu]}
            openKeys={menuOpenKeys}
            onOpenChange={setMenuOpenKeys}
            items={menuItems}
            onClick={({ key }) => {
              if ((VALID_MENU_KEYS as readonly string[]).includes(key) || key === 'configuration' || key === 'ip-detection' || key === 'announce') {
                if (key !== 'configuration' && key !== 'ip-detection' && key !== 'announce') setSelectedMenu(key);
              }
            }}
          />
        </div>
        <div
          style={{
            flexShrink: 0,
            padding: '12px 16px',
            borderTop: '1px solid rgba(255,255,255,0.1)',
            background: 'rgba(0,0,0,0.25)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 10,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1, minWidth: 0 }}>
            <div
              style={{
                width: 36,
                height: 36,
                borderRadius: '50%',
                background: 'rgba(92, 107, 192, 0.9)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#fff',
                fontSize: 16,
                fontWeight: 600,
                flexShrink: 0,
              }}
            >
              {avatarLetter}
            </div>
            <div style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}>
              <div style={{ color: 'rgba(255,255,255,0.9)', fontWeight: 600, fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {displayName}
              </div>
              <div style={{ color: 'rgba(255,255,255,0.6)', fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {roleLabel}
              </div>
            </div>
          </div>
          <Button
            type="text"
            icon={<LogoutOutlined />}
            onClick={() => logout()}
            style={{ color: 'rgba(255,255,255,0.65)', flexShrink: 0, padding: '4px 8px' }}
            title="退出登录"
          />
        </div>
        </div>
      </Sider>
      <Layout style={{ marginLeft: 200, flex: 1, minWidth: 0 }}>
        <Content
          style={{ margin: 0, minHeight: 280, background: '#f0f2f5', padding: 24, minWidth: 0, width: '100%' }}
        >
          {selectedMenu === 'ip-management' && <IPManagement />}
          {selectedMenu === 'irr-detection' && <IRRDetection />}
          {selectedMenu === 'pre-purchase-check' && <PrePurchaseCheck />}
          {selectedMenu === 'cost-analysis-main' && <CostAnalysis />}
          {selectedMenu === 'cost-analysis-ipxo' && <IPXOBilling />}
          {selectedMenu === 'ip-segment-stats' && <IPSegmentStats />}
          {selectedMenu === 'config-suppliers' && <SupplierConfigPage />}
          {selectedMenu === 'config-usage-areas' && <UsageAreaConfigPage />}
          {selectedMenu === 'config-project-groups' && <ProjectGroupConfigPage />}
          {selectedMenu === 'asn-management' && <AsnConfigPage />}
          {selectedMenu === 'asn-standby-a' && <AsnStandbyPage group="A" />}
          {selectedMenu === 'asn-standby-b' && <AsnStandbyPage group="B" />}
          {selectedMenu === 'user-management' && <UserManagement />}
          {selectedMenu === 'notify-config' && <NotifyConfig />}
          {selectedMenu === 'announce-zen' && <ZenAnnounce />}
          {selectedMenu === 'announce-capital-online' && <CapitalOnlineAnnounce />}
        </Content>
      </Layout>
    </Layout>
  );
};

class AppErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean; err: Error | null }
> {
  state = { hasError: false, err: null as Error | null };

  static getDerivedStateFromError(err: Error) {
    return { hasError: true, err };
  }

  componentDidCatch(err: Error, info: React.ErrorInfo) {
    console.error('AppErrorBoundary:', err, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: 24, maxWidth: 720, margin: '48px auto', fontFamily: 'system-ui' }}>
          <h2 style={{ color: '#cf1322' }}>页面渲染出错</h2>
          <p style={{ color: 'rgba(0,0,0,0.65)' }}>请刷新重试。若持续出现，请将下方信息反馈给管理员。</p>
          <pre
            style={{
              background: '#fff1f0',
              padding: 12,
              borderRadius: 8,
              overflow: 'auto',
              fontSize: 13,
            }}
          >
            {this.state.err?.message ?? '未知错误'}
          </pre>
        </div>
      );
    }
    return this.props.children;
  }
}

const App: React.FC = () => (
  <ConfigProvider locale={zhCN}>
    <AntdApp>
      <AuthProvider>
        <AppErrorBoundary>
          <AppContent />
        </AppErrorBoundary>
      </AuthProvider>
    </AntdApp>
  </ConfigProvider>
);

export default App;


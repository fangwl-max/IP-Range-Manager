import React from 'react';
import { Tabs, Result } from 'antd';
import { GlobalOutlined, StopOutlined, LockOutlined } from '@ant-design/icons';
import ZenByoipAnnounceTab from './ZenByoipAnnounceTab';
import ZenByoipWithdrawTab from './ZenByoipWithdrawTab';
import { useAuth } from '../contexts/AuthContext';

interface RegionOption { regionId: string; label: string; }

interface Props {
  regionOptions: RegionOption[];
  onRegionsLoaded?: (options: RegionOption[]) => void;
}

const PermGate: React.FC<{ perm: string; children: React.ReactNode }> = ({ perm, children }) => {
  const { hasPermission } = useAuth();
  if (!hasPermission(perm)) {
    return (
      <Result
        icon={<LockOutlined style={{ color: '#faad14' }} />}
        title="权限不足"
        subTitle="您没有访问此功能的权限"
      />
    );
  }
  return <>{children}</>;
};

const ZenVobTab: React.FC<Props> = ({ regionOptions, onRegionsLoaded }) => (
  <Tabs
    defaultActiveKey="vob-announce"
    size="small"
    items={[
      {
        key: 'vob-announce',
        label: <span><GlobalOutlined /> VOB 宣告</span>,
        children: (
          <PermGate perm="announce-zen.announce">
            <ZenByoipAnnounceTab
              regionOptions={regionOptions}
              onRegionsLoaded={onRegionsLoaded}
            />
          </PermGate>
        ),
      },
      {
        key: 'vob-withdraw',
        label: <span><StopOutlined /> VOB 取消宣告</span>,
        children: <PermGate perm="announce-zen.withdraw"><ZenByoipWithdrawTab regionOptions={regionOptions} /></PermGate>,
      },
    ]}
  />
);

export default ZenVobTab;

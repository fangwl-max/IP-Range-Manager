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

const AdminOnly: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { user } = useAuth();
  if (user?.role !== 'admin') {
    return (
      <Result
        icon={<LockOutlined style={{ color: '#faad14' }} />}
        title="权限不足"
        subTitle="该功能仅限管理员账号操作"
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
          <ZenByoipAnnounceTab
            regionOptions={regionOptions}
            onRegionsLoaded={onRegionsLoaded}
          />
        ),
      },
      {
        key: 'vob-withdraw',
        label: <span><StopOutlined /> VOB 取消宣告</span>,
        children: <AdminOnly><ZenByoipWithdrawTab regionOptions={regionOptions} /></AdminOnly>,
      },
    ]}
  />
);

export default ZenVobTab;

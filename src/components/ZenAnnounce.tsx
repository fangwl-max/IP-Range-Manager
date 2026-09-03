import React, { useState } from 'react';
import { Tabs, Result, Button } from 'antd';
import { LockOutlined } from '@ant-design/icons';
import {
  SoundOutlined, DeleteOutlined, GlobalOutlined, ScissorOutlined,
  UnorderedListOutlined,
} from '@ant-design/icons';
import ZenAnnounceTab from './ZenAnnounceTab';
import ZenEipDelete from './ZenEipDelete';
import ZenVobTab from './ZenVobTab';
import ZenCidrDeleteTab from './ZenCidrDeleteTab';
import ZenAnnouncedList from './ZenAnnouncedList';
import { useAuth } from '../contexts/AuthContext';

interface RegionOption { regionId: string; label: string; }

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

const ZenAnnounce: React.FC = () => {
  const [regionOptions, setRegionOptions] = useState<RegionOption[]>([]);

  return (
    <div style={{ background: '#fff', borderRadius: 8, padding: 16, boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }}>
      <Tabs
        defaultActiveKey="announce"
        items={[
          {
            key: 'announce',
            label: <span><SoundOutlined /> ZEC 宣告</span>,
            children: (
              <Tabs
                defaultActiveKey="zec-announce"
                size="small"
                items={[
                  {
                    key: 'zec-announce',
                    label: <span><SoundOutlined /> ZEC 宣告</span>,
                    children: <PermGate perm="announce-zen.announce"><ZenAnnounceTab onRegionsLoaded={setRegionOptions} /></PermGate>,
                  },
                  {
                    key: 'zec-eip-delete',
                    label: <span><DeleteOutlined /> ZEC 删除弹性IP</span>,
                    children: <PermGate perm="announce-zen.withdraw"><ZenEipDelete regionOptions={regionOptions} /></PermGate>,
                  },
                  {
                    key: 'zec-cidr-delete',
                    label: <span><ScissorOutlined /> ZEC 取消宣告</span>,
                    children: <PermGate perm="announce-zen.withdraw"><ZenCidrDeleteTab regionOptions={regionOptions} /></PermGate>,
                  },
                ]}
              />
            ),
          },
          {
            key: 'vob',
            label: <span><GlobalOutlined /> VOB 宣告</span>,
            children: (
              <ZenVobTab
                regionOptions={regionOptions}
                onRegionsLoaded={setRegionOptions}
              />
            ),
          },
          {
            key: 'announced',
            label: <span><UnorderedListOutlined /> 已宣告IP段</span>,
            children: <ZenAnnouncedList />,
          },
        ]}
      />
    </div>
  );
};

export default ZenAnnounce;

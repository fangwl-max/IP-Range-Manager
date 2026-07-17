import React, { useState } from 'react';
import { Tabs, Result, Button } from 'antd';
import { LockOutlined } from '@ant-design/icons';
import {
  SoundOutlined, DeleteOutlined, GlobalOutlined, ScissorOutlined,
} from '@ant-design/icons';
import ZenAnnounceTab from './ZenAnnounceTab';
import ZenEipDelete from './ZenEipDelete';
import ZenVobTab from './ZenVobTab';
import ZenCidrDeleteTab from './ZenCidrDeleteTab';
import { useAuth } from '../contexts/AuthContext';

interface RegionOption { regionId: string; label: string; }

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
                    children: <ZenAnnounceTab onRegionsLoaded={setRegionOptions} />,
                  },
                  {
                    key: 'zec-eip-delete',
                    label: <span><DeleteOutlined /> EIP 删除</span>,
                    children: <AdminOnly><ZenEipDelete regionOptions={regionOptions} /></AdminOnly>,
                  },
                  {
                    key: 'zec-cidr-delete',
                    label: <span><ScissorOutlined /> CIDR 删除</span>,
                    children: <AdminOnly><ZenCidrDeleteTab regionOptions={regionOptions} /></AdminOnly>,
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
        ]}
      />
    </div>
  );
};

export default ZenAnnounce;

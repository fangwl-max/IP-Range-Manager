import React, { useState } from 'react';
import { Tabs } from 'antd';
import {
  SoundOutlined, DeleteOutlined, GlobalOutlined, ScissorOutlined,
} from '@ant-design/icons';
import ZenAnnounceTab from './ZenAnnounceTab';
import ZenEipDelete from './ZenEipDelete';
import ZenVobTab from './ZenVobTab';
import ZenCidrDeleteTab from './ZenCidrDeleteTab';

interface RegionOption { regionId: string; label: string; }

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
                    children: <ZenEipDelete regionOptions={regionOptions} />,
                  },
                  {
                    key: 'zec-cidr-delete',
                    label: <span><ScissorOutlined /> CIDR 删除</span>,
                    children: <ZenCidrDeleteTab regionOptions={regionOptions} />,
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

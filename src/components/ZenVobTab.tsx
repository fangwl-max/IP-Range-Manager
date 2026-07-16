import React from 'react';
import { Tabs } from 'antd';
import { GlobalOutlined, StopOutlined } from '@ant-design/icons';
import ZenByoipAnnounceTab from './ZenByoipAnnounceTab';
import ZenByoipWithdrawTab from './ZenByoipWithdrawTab';

interface RegionOption { regionId: string; label: string; }

interface Props {
  regionOptions: RegionOption[];
  onRegionsLoaded?: (options: RegionOption[]) => void;
}

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
        children: <ZenByoipWithdrawTab regionOptions={regionOptions} />,
      },
    ]}
  />
);

export default ZenVobTab;

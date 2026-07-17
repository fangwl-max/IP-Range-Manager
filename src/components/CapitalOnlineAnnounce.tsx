import React from 'react';
import { Typography } from 'antd';

const { Text } = Typography;

const CapitalOnlineAnnounce: React.FC = () => {
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
      <div style={{ padding: '8px 16px', borderBottom: '1px solid #f0f0f0', display: 'flex', alignItems: 'center', gap: 8 }}>
        <Text type="secondary" style={{ fontSize: 12 }}>
          首都在线宣告系统（CDS-Auto-Announce）
        </Text>
      </div>
      <iframe
        src="/cds-proxy/"
        style={{ flex: 1, border: 'none', width: '100%' }}
        title="首都在线宣告"
        allow="same-origin"
      />
    </div>
  );
};

export default CapitalOnlineAnnounce;

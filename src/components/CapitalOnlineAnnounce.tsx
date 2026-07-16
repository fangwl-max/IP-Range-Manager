import React from 'react';
import { Empty, Typography } from 'antd';
import { ToolOutlined } from '@ant-design/icons';

const { Title, Text } = Typography;

const CapitalOnlineAnnounce: React.FC = () => {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        height: 'calc(100vh - 96px)',
        background: '#fff',
        borderRadius: 8,
        boxShadow: '0 1px 4px rgba(0,0,0,0.06)',
      }}
    >
      <Empty
        image={
          <ToolOutlined
            style={{ fontSize: 64, color: '#d9d9d9' }}
          />
        }
        imageStyle={{ height: 80 }}
        description={
          <div style={{ textAlign: 'center' }}>
            <Title level={4} style={{ marginBottom: 8, color: 'rgba(0,0,0,0.45)' }}>
              首都在线宣告
            </Title>
            <Text type="secondary">功能开发中，敬请期待…</Text>
          </div>
        }
      />
    </div>
  );
};

export default CapitalOnlineAnnounce;

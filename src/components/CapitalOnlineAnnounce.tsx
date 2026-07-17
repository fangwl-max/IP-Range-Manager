import React, { useEffect, useRef, useState } from 'react';
import { Alert, Spin, Typography } from 'antd';
import { getAuthHeaders } from '../contexts/AuthContext';

const { Text } = Typography;

/**
 * 首都在线宣告页面
 * 通过 /cds-proxy 代理访问 CDS-Auto-Announce Flask 服务（端口 9010）。
 * 主系统 token 会通过代理层转换为内部 token，Flask 自动以 admin 身份信任。
 */
const CapitalOnlineAnnounce: React.FC = () => {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [status, setStatus] = useState<'loading' | 'ok' | 'error'>('loading');
  const [errMsg, setErrMsg] = useState('');

  // 检查 CDS 服务是否可用
  useEffect(() => {
    const headers = getAuthHeaders();
    fetch('/cds-proxy/', { headers, redirect: 'manual' })
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

  // iframe 加载完成后尝试隐藏 Flask 的导航栏（同域可操作）
  const handleLoad = () => {
    try {
      const doc = iframeRef.current?.contentDocument;
      if (doc) {
        const style = doc.createElement('style');
        style.textContent = '.nav { display: none !important; } .topbar { padding-top: 8px !important; }';
        doc.head?.appendChild(style);
      }
    } catch {
      // 跨域限制下无法操作，忽略
    }
  };

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
          ref={iframeRef}
          src="/cds-proxy/"
          style={{ flex: 1, border: 'none', width: '100%' }}
          title="首都在线宣告"
          onLoad={handleLoad}
        />
      )}
    </div>
  );
};

export default CapitalOnlineAnnounce;

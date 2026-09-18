import React, { useState, useEffect, useRef } from 'react';
import { App, Form, Input, Button, ConfigProvider } from 'antd';
import { UserOutlined, LockOutlined, DownOutlined } from '@ant-design/icons';
import { useAuth } from '../contexts/AuthContext';

const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined;

const Login: React.FC = () => {
  const [loading, setLoading] = useState(false);
  const { login, loginWithGoogle } = useAuth();
  const [form] = Form.useForm();
  const { message } = App.useApp();
  const googleBtnRef = useRef<HTMLDivElement>(null);
  const googleInitialized = useRef(false);
  const [mounted, setMounted] = useState(false);
  // 密码登录默认隐藏（仅当配置了 Google 时）
  const [showPassword, setShowPassword] = useState(!GOOGLE_CLIENT_ID);

  useEffect(() => {
    const id = requestAnimationFrame(() => setMounted(true));
    return () => cancelAnimationFrame(id);
  }, []);

  useEffect(() => {
    if (!GOOGLE_CLIENT_ID || googleInitialized.current) return;
    const tryInit = () => {
      const google = (window as any).google;
      if (!google?.accounts?.id) return false;
      google.accounts.id.initialize({
        client_id: GOOGLE_CLIENT_ID,
        callback: async (resp: any) => {
          const r = await loginWithGoogle(resp.credential);
          if (r.success) { message.destroy(); message.success('登录成功'); }
          else message.error(r.message || 'Google 登录失败');
        },
      });
      if (googleBtnRef.current) {
        google.accounts.id.renderButton(googleBtnRef.current, {
          theme: 'outline', size: 'large', text: 'signin_with', locale: 'zh-CN', width: 320,
        });
      }
      googleInitialized.current = true;
      return true;
    };
    if (!tryInit()) {
      const timer = setInterval(() => { if (tryInit()) clearInterval(timer); }, 200);
      return () => clearInterval(timer);
    }
  }, [loginWithGoogle, message]);

  const onFinish = async (values: { username: string; password: string }) => {
    setLoading(true);
    try {
      const result = await login(values.username, values.password);
      if (!result.success) message.error(result.message || '用户名或密码错误');
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <style>{`
        html, body, #root {
          margin: 0;
          padding: 0;
          min-height: 100%;
        }
        .nl-root {
          min-height: 100vh;
          width: 100%;
          display: flex;
          align-items: center;
          justify-content: center;
          background: linear-gradient(145deg, #0f0d2e 0%, #1a0d40 45%, #0c1a3c 100%);
          position: relative;
          overflow: hidden;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', sans-serif;
        }

        /* 随机点阵：SVG 瓦片内手动散布，大小/间距无规律 */
        .nl-grid {
          position: absolute; inset: 0; pointer-events: none;
          background-image: url("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='480' height='480'><circle cx='27' cy='45' r='1' fill='white' fill-opacity='.10'/><circle cx='89' cy='167' r='1' fill='white' fill-opacity='.12'/><circle cx='234' cy='23' r='1' fill='white' fill-opacity='.09'/><circle cx='367' cy='89' r='1' fill='white' fill-opacity='.11'/><circle cx='145' cy='245' r='1' fill='white' fill-opacity='.10'/><circle cx='312' cy='167' r='1' fill='white' fill-opacity='.12'/><circle cx='56' cy='312' r='1' fill='white' fill-opacity='.09'/><circle cx='189' cy='389' r='1' fill='white' fill-opacity='.11'/><circle cx='445' cy='134' r='1' fill='white' fill-opacity='.10'/><circle cx='78' cy='456' r='1' fill='white' fill-opacity='.12'/><circle cx='267' cy='289' r='1' fill='white' fill-opacity='.09'/><circle cx='389' cy='345' r='1' fill='white' fill-opacity='.11'/><circle cx='123' cy='123' r='1' fill='white' fill-opacity='.10'/><circle cx='345' cy='267' r='1' fill='white' fill-opacity='.12'/><circle cx='12' cy='234' r='1' fill='white' fill-opacity='.09'/><circle cx='456' cy='389' r='1' fill='white' fill-opacity='.11'/><circle cx='178' cy='56' r='1' fill='white' fill-opacity='.10'/><circle cx='289' cy='456' r='1' fill='white' fill-opacity='.12'/><circle cx='467' cy='200' r='1' fill='white' fill-opacity='.09'/><circle cx='100' cy='350' r='1' fill='white' fill-opacity='.11'/><circle cx='200' cy='320' r='1' fill='white' fill-opacity='.10'/><circle cx='430' cy='45' r='1' fill='white' fill-opacity='.11'/><circle cx='35' cy='400' r='1' fill='white' fill-opacity='.09'/><circle cx='260' cy='390' r='1' fill='white' fill-opacity='.12'/><circle cx='330' cy='330' r='1' fill='white' fill-opacity='.10'/><circle cx='160' cy='470' r='1' fill='white' fill-opacity='.09'/><circle cx='415' cy='230' r='1' fill='white' fill-opacity='.11'/><circle cx='50' cy='70' r='1' fill='white' fill-opacity='.10'/><circle cx='290' cy='145' r='1' fill='white' fill-opacity='.12'/><circle cx='195' cy='215' r='1' fill='white' fill-opacity='.09'/><circle cx='370' cy='430' r='1' fill='white' fill-opacity='.11'/><circle cx='130' cy='380' r='1' fill='white' fill-opacity='.10'/><circle cx='400' cy='170' r='1' fill='white' fill-opacity='.12'/><circle cx='245' cy='470' r='1' fill='white' fill-opacity='.09'/><circle cx='470' cy='450' r='1' fill='white' fill-opacity='.10'/><circle cx='223' cy='145' r='1.7' fill='white' fill-opacity='.15'/><circle cx='89' cy='345' r='1.7' fill='white' fill-opacity='.17'/><circle cx='356' cy='189' r='1.7' fill='white' fill-opacity='.15'/><circle cx='145' cy='423' r='1.7' fill='white' fill-opacity='.17'/><circle cx='412' cy='67' r='1.7' fill='white' fill-opacity='.15'/><circle cx='45' cy='178' r='1.7' fill='white' fill-opacity='.17'/><circle cx='300' cy='400' r='1.7' fill='white' fill-opacity='.15'/><circle cx='340' cy='90' r='1.7' fill='white' fill-opacity='.17'/><circle cx='220' cy='430' r='1.7' fill='white' fill-opacity='.15'/><circle cx='155' cy='190' r='2' fill='white' fill-opacity='.18'/><circle cx='380' cy='460' r='2' fill='white' fill-opacity='.16'/><circle cx='178' cy='289' r='3' fill='rgb(138,120,255)' fill-opacity='.38'/><circle cx='390' cy='345' r='3' fill='rgb(138,120,255)' fill-opacity='.36'/><circle cx='67' cy='89' r='3' fill='rgb(138,120,255)' fill-opacity='.40'/><circle cx='310' cy='120' r='2.5' fill='rgb(110,140,255)' fill-opacity='.32'/><circle cx='450' cy='290' r='2.5' fill='rgb(110,140,255)' fill-opacity='.30'/></svg>");
          background-size: 480px 480px;
          background-repeat: repeat;
        }

        /* 光晕 */
        .nl-glow {
          position: absolute; inset: 0; pointer-events: none;
          background:
            radial-gradient(ellipse 65% 65% at 15% 40%, rgba(99,102,241,0.32) 0%, transparent 65%),
            radial-gradient(ellipse 55% 55% at 85% 15%, rgba(139,92,246,0.24) 0%, transparent 65%),
            radial-gradient(ellipse 50% 50% at 70% 88%, rgba(59,130,246,0.2) 0%, transparent 65%);
        }

        /* 卡片 */
        .nl-card {
          width: 400px;
          padding: 44px 40px 40px;
          background: rgba(22, 14, 62, 0.65);
          backdrop-filter: blur(48px);
          -webkit-backdrop-filter: blur(48px);
          border: 1px solid rgba(255,255,255,0.11);
          border-radius: 20px;
          box-shadow: 0 32px 80px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.09);
          position: relative; z-index: 1;
          opacity: 0; transform: translateY(14px);
          transition: opacity 0.5s cubic-bezier(0.16,1,0.3,1), transform 0.5s cubic-bezier(0.16,1,0.3,1);
        }
        .nl-card.show { opacity: 1; transform: translateY(0); }

        /* 品牌 icon */
        .nl-icon {
          display: inline-flex; width: 54px; height: 54px; border-radius: 16px;
          background: linear-gradient(145deg, #6366f1, #7c3aed);
          align-items: center; justify-content: center; margin-bottom: 18px;
          box-shadow: 0 8px 28px rgba(99,102,241,0.45);
        }
        .nl-title { color: #f0f2ff; font-size: 22px; font-weight: 700; letter-spacing: -0.4px; margin: 0 0 6px; }
        .nl-sub { color: rgba(255,255,255,0.3); font-size: 13px; margin: 0; }

        /* Google 按钮区 */
        .nl-google-wrap {
          display: flex; flex-direction: column; align-items: center; gap: 14px;
          margin-bottom: 6px;
        }

        /* 密码登录展开/收起 toggle */
        .nl-pass-toggle {
          display: flex; align-items: center; justify-content: center; gap: 5px;
          color: rgba(255,255,255,0.28); font-size: 12px;
          cursor: pointer; padding: 10px 0; margin-top: 8px;
          border: none; background: none; width: 100%;
          transition: color 0.2s;
          letter-spacing: 0.3px;
        }
        .nl-pass-toggle:hover { color: rgba(255,255,255,0.55); }
        .nl-pass-toggle .arrow {
          display: inline-flex;
          transition: transform 0.35s cubic-bezier(0.16,1,0.3,1);
          font-size: 10px;
        }
        .nl-pass-toggle .arrow.open { transform: rotate(180deg); }

        /* 密码表单滑动展开 */
        .nl-pass-form-wrap {
          overflow: hidden;
          max-height: 0;
          transition: max-height 0.4s cubic-bezier(0.16,1,0.3,1), opacity 0.35s ease;
          opacity: 0;
        }
        .nl-pass-form-wrap.open {
          max-height: 320px;
          opacity: 1;
        }

        /* 分割线 */
        .nl-sep { display: flex; align-items: center; gap: 12px; margin: 4px 0 12px; }
        .nl-sep-line { flex: 1; height: 1px; background: rgba(255,255,255,0.07); }
        .nl-sep-txt { color: rgba(255,255,255,0.2); font-size: 12px; }

        .nl-footer { text-align: center; margin-top: 28px; color: rgba(255,255,255,0.16); font-size: 12px; }

        /* Input dark overrides */
        .nl-form .ant-input-affix-wrapper {
          background: rgba(255,255,255,0.09) !important;
          border-color: rgba(255,255,255,0.14) !important;
        }
        .nl-form .ant-input-affix-wrapper:hover {
          border-color: rgba(130,120,255,0.55) !important;
        }
        .nl-form .ant-input-affix-wrapper-focused {
          border-color: #818cf8 !important;
          box-shadow: 0 0 0 3px rgba(99,102,241,0.18) !important;
        }
        .nl-form .ant-input { background: transparent !important; color: rgba(255,255,255,0.92) !important; }
        .nl-form .ant-input::placeholder { color: rgba(255,255,255,0.35) !important; }
        .nl-form .ant-input-password-icon { color: rgba(255,255,255,0.28) !important; }
        .nl-form .ant-input-password-icon:hover { color: rgba(255,255,255,0.55) !important; }
        .nl-form .ant-form-item-explain-error { font-size: 12px; margin-top: 4px; color: #f87171 !important; }
      `}</style>

      <div className="nl-root">
        <div className="nl-grid" />
        <div className="nl-glow" />

        <div className={`nl-card${mounted ? ' show' : ''}`}>
          {/* 品牌 */}
          <div style={{ textAlign: 'center', marginBottom: 32 }}>
            <div className="nl-icon">
              <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
                <rect x="3" y="3" width="9" height="9" rx="2.5" fill="white" fillOpacity="0.95" />
                <rect x="16" y="3" width="9" height="9" rx="2.5" fill="white" fillOpacity="0.5" />
                <rect x="3" y="16" width="9" height="9" rx="2.5" fill="white" fillOpacity="0.5" />
                <rect x="16" y="16" width="9" height="9" rx="2.5" fill="white" fillOpacity="0.95" />
              </svg>
            </div>
            <p className="nl-title">IP 段管理平台</p>
            <p className="nl-sub">IP Address Management Console</p>
          </div>

          {/* ── Google 主登录 ── */}
          {GOOGLE_CLIENT_ID && (
            <div className="nl-google-wrap">
              <div ref={googleBtnRef} />
            </div>
          )}

          {/* ── 密码登录（次要，可折叠）── */}
          {GOOGLE_CLIENT_ID && (
            <button
              className="nl-pass-toggle"
              onClick={() => setShowPassword(v => !v)}
              type="button"
            >
              使用账号密码登录
              <span className={`arrow${showPassword ? ' open' : ''}`}>
                <DownOutlined />
              </span>
            </button>
          )}

          <div className={`nl-pass-form-wrap${showPassword ? ' open' : ''}`}>
            {GOOGLE_CLIENT_ID && (
              <div className="nl-sep" style={{ marginTop: 4 }}>
                <div className="nl-sep-line" />
                <span className="nl-sep-txt">账号密码</span>
                <div className="nl-sep-line" />
              </div>
            )}

                <Form form={form} onFinish={onFinish} layout="vertical" className="nl-form">
                <Form.Item name="username" style={{ marginBottom: 14 }} rules={[{ required: true, message: '请输入用户名' }]}>
                  <Input
                    prefix={<UserOutlined style={{ color: 'rgba(255,255,255,0.32)', fontSize: 14 }} />}
                    placeholder="用户名"
                    autoComplete="username"
                    style={{
                      height: 46, borderRadius: 10,
                      background: 'rgba(255,255,255,0.09)',
                      border: '1px solid rgba(255,255,255,0.14)',
                    }}
                    styles={{ input: { color: 'rgba(255,255,255,0.92)', background: 'transparent' } }}
                  />
                </Form.Item>
                <Form.Item name="password" style={{ marginBottom: 16 }} rules={[{ required: true, message: '请输入密码' }]}>
                  <Input.Password
                    prefix={<LockOutlined style={{ color: 'rgba(255,255,255,0.32)', fontSize: 14 }} />}
                    placeholder="密码"
                    autoComplete="current-password"
                    style={{
                      height: 46, borderRadius: 10,
                      background: 'rgba(255,255,255,0.09)',
                      border: '1px solid rgba(255,255,255,0.14)',
                    }}
                    styles={{ input: { color: 'rgba(255,255,255,0.92)', background: 'transparent' } }}
                  />
                </Form.Item>
                <Form.Item style={{ marginBottom: 0 }}>
                  <Button
                    type="primary"
                    htmlType="submit"
                    loading={loading}
                    block
                    style={{
                      height: 46, borderRadius: 10,
                      background: 'linear-gradient(135deg, #6366f1 0%, #7c3aed 100%)',
                      border: 'none', fontSize: 14, fontWeight: 600,
                      boxShadow: '0 6px 22px rgba(99,102,241,0.4)',
                    }}
                  >
                    登录
                  </Button>
                </Form.Item>
              </Form>
          </div>

          <p className="nl-footer">nodelink.it · 仅限内部使用</p>
        </div>
      </div>
    </>
  );
};

export default Login;

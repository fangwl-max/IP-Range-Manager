import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import type { User } from '../types/auth';

const AUTH_TOKEN_KEY = 'ip-management-auth-token';

interface AuthContextType {
  user: User | null;
  token: string | null;
  loading: boolean;
  login: (username: string, password: string) => Promise<{ success: boolean; message?: string }>;
  logout: () => Promise<void>;
  hasPermission: (permission: string) => boolean;
}

const AuthContext = createContext<AuthContextType | null>(null);

const ROLE_PERMISSIONS: Record<string, string[]> = {
  admin: ['view_ip', 'edit_ip', 'delete_ip', 'import_export', 'view_cost', 'view_irr', 'manage_config', 'manage_users'],
  editor: ['view_ip', 'edit_ip', 'delete_ip', 'import_export', 'view_cost', 'view_irr', 'manage_config'],
  viewer: ['view_ip', 'view_cost', 'view_irr'],
};

function getAuthHeader(): Record<string, string> {
  const token = localStorage.getItem(AUTH_TOKEN_KEY);
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchCurrentUser = useCallback(async () => {
    const savedToken = localStorage.getItem(AUTH_TOKEN_KEY);
    if (!savedToken) {
      setUser(null);
      setToken(null);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), 15000);
    try {
      const res = await fetch('/api/auth/me', {
        headers: getAuthHeader(),
        signal: controller.signal,
      });
      const text = await res.text();
      let data: { success?: boolean; user?: User | null } = {};
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        localStorage.removeItem(AUTH_TOKEN_KEY);
        setUser(null);
        setToken(null);
        return;
      }
      if (data.success && data.user) {
        setUser(data.user);
        setToken(savedToken);
      } else {
        localStorage.removeItem(AUTH_TOKEN_KEY);
        setUser(null);
        setToken(null);
      }
    } catch {
      localStorage.removeItem(AUTH_TOKEN_KEY);
      setUser(null);
      setToken(null);
    } finally {
      window.clearTimeout(timeoutId);
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchCurrentUser();
  }, [fetchCurrentUser]);

  const login = useCallback(async (username: string, password: string) => {
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username.trim(), password }),
      });
      const data = await res.json();
      if (data.success && data.user && data.token) {
        localStorage.setItem(AUTH_TOKEN_KEY, data.token);
        setUser(data.user);
        setToken(data.token);
        return { success: true };
      }
      return { success: false, message: data.message || '登录失败' };
    } catch (e: any) {
      return { success: false, message: e.message || '网络错误' };
    }
  }, []);

  const logout = useCallback(async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST', headers: getAuthHeader() });
    } catch {}
    localStorage.removeItem(AUTH_TOKEN_KEY);
    setUser(null);
    setToken(null);
  }, []);

  const hasPermission = useCallback((permission: string) => {
    if (!user) return false;
    const perms = ROLE_PERMISSIONS[user.role];
    return perms ? perms.includes(permission) : false;
  }, [user]);

  return (
    <AuthContext.Provider value={{ user, token, loading, login, logout, hasPermission }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}

export function getAuthHeaders(): Record<string, string> {
  return getAuthHeader();
}

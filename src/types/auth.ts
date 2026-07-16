// 用户角色
export type UserRole = 'admin' | 'editor' | 'viewer';

// 用户信息
export interface User {
  id: string;
  username: string;
  displayName?: string;
  role: UserRole;
  createdAt: string;
  updatedAt: string;
}

// 登录请求
export interface LoginRequest {
  username: string;
  password: string;
}

// 登录响应
export interface LoginResponse {
  success: boolean;
  user?: User;
  token?: string;
  message?: string;
}

// 存储在 users.json 的用户记录（含密码哈希）
export interface UserRecord {
  id: string;
  username: string;
  passwordHash: string; // sha256 哈希
  displayName?: string;
  role: UserRole;
  createdAt: string;
  updatedAt: string;
}

// 权限定义
export const PERMISSIONS = {
  VIEW_IP: 'view_ip',
  EDIT_IP: 'edit_ip',
  DELETE_IP: 'delete_ip',
  IMPORT_EXPORT: 'import_export',
  VIEW_COST: 'view_cost',
  VIEW_IRR: 'view_irr',
  MANAGE_CONFIG: 'manage_config',
  MANAGE_USERS: 'manage_users',
} as const;

// 角色权限映射
export const ROLE_PERMISSIONS: Record<UserRole, string[]> = {
  admin: Object.values(PERMISSIONS),
  editor: [
    PERMISSIONS.VIEW_IP,
    PERMISSIONS.EDIT_IP,
    PERMISSIONS.DELETE_IP,
    PERMISSIONS.IMPORT_EXPORT,
    PERMISSIONS.VIEW_COST,
    PERMISSIONS.VIEW_IRR,
    PERMISSIONS.MANAGE_CONFIG,
  ],
  viewer: [
    PERMISSIONS.VIEW_IP,
    PERMISSIONS.VIEW_COST,
    PERMISSIONS.VIEW_IRR,
  ],
};

export type UserRole = 'admin' | 'editor' | 'viewer';

export interface User {
  id: string;
  username: string;
  displayName?: string;
  role: UserRole;
  permissions?: string[];
  createdAt: string;
  updatedAt: string;
}

export interface LoginRequest {
  username: string;
  password: string;
}

export interface LoginResponse {
  success: boolean;
  user?: User;
  token?: string;
  message?: string;
}

export interface UserRecord {
  id: string;
  username: string;
  passwordHash: string;
  displayName?: string;
  role: UserRole;
  permissions?: string[];
  createdAt: string;
  updatedAt: string;
}

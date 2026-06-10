export type UserRole = 'admin' | 'operator' | 'viewer';

export type Permission =
  | 'logs:read'
  | 'logs:write'
  | 'dashboards:write'
  | 'system:read'
  | 'settings:write'
  | 'users:manage';

export interface UserRecord {
  id: string;
  username: string;
  email: string;
  displayName: string;
  passwordHash: string;
  role: UserRole;
  enabled: boolean;
  lastLoginAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface PublicUser {
  id: string;
  username: string;
  email: string;
  displayName: string;
  role: UserRole;
  enabled: boolean;
  permissions: Permission[];
  lastLoginAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateUserInput {
  username: string;
  email: string;
  password: string;
  displayName?: string;
  role?: UserRole;
  enabled?: boolean;
}

export interface UpdateUserInput {
  username?: string;
  email?: string;
  displayName?: string;
  role?: UserRole;
  enabled?: boolean;
}

export interface ChangePasswordInput {
  currentPassword: string;
  newPassword: string;
}

export const ROLE_PERMISSIONS: Record<UserRole, Permission[]> = {
  admin: ['logs:read', 'logs:write', 'dashboards:write', 'system:read', 'settings:write', 'users:manage'],
  operator: ['logs:read', 'logs:write', 'dashboards:write', 'system:read'],
  viewer: ['logs:read'],
};

export function isUserRole(value: unknown): value is UserRole {
  return value === 'admin' || value === 'operator' || value === 'viewer';
}

export function permissionsForRole(role: UserRole): Permission[] {
  return ROLE_PERMISSIONS[role];
}

export function toPublicUser(user: UserRecord): PublicUser {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
    enabled: user.enabled,
    permissions: permissionsForRole(user.role),
    lastLoginAt: user.lastLoginAt,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

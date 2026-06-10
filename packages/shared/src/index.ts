export interface AuthUser {
  email: string;
  role: string;
  permissions: string[];
}

export interface ApiEnvelope<T> {
  success: boolean;
  data?: T;
  error?: string;
}

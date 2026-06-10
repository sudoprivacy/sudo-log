export interface ProductRecord {
  id: string;
  tenantId: string;
  product: string;
  name: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface TenantRecord {
  id: string;
  tenantId: string;
  name: string;
  apiKey: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface TenantWithProducts extends TenantRecord {
  products: ProductRecord[];
}

export interface PublicTenantWithProducts extends Omit<TenantRecord, 'apiKey'> {
  apiKey?: string;
  products: ProductRecord[];
}

export interface CreateTenantInput {
  tenantId: string;
  name?: string;
  apiKey?: string;
  enabled?: boolean;
}

export interface UpdateTenantInput {
  name?: string;
  enabled?: boolean;
}

export interface CreateProductInput {
  tenantId: string;
  product: string;
  name?: string;
  enabled?: boolean;
}

export interface UpdateProductInput {
  name?: string;
  enabled?: boolean;
}

export type GrafanaPanelType = 'timeseries' | 'table' | 'barchart' | 'stat';

export interface GrafanaCustomPanelRecord {
  id: string;
  tenantId: string;
  product: string;
  title: string;
  description: string;
  panelType: GrafanaPanelType;
  querySql: string;
  height: number;
  enabled: boolean;
  dashboardUid: string;
  dashboardSlug: string;
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
  publishedAt: string;
  publishError: string;
}

export interface CreateGrafanaCustomPanelInput {
  tenantId: string;
  product: string;
  title: string;
  description?: string;
  panelType?: GrafanaPanelType;
  querySql: string;
  height?: number;
  enabled?: boolean;
  actor: string;
}

export interface UpdateGrafanaCustomPanelInput {
  title?: string;
  description?: string;
  panelType?: GrafanaPanelType;
  querySql?: string;
  height?: number;
  enabled?: boolean;
  actor: string;
}

export type PaymentProvider = 'alipay' | 'wechat';
export interface Env {
  ASSETS: Fetcher;
  PAY_BASE_URL: string;
  PAYMENT_MODE: 'live' | 'sandbox';
  PAYMENT_ENABLED: string;
  ALIPAY_CHANNELS: string;
  ALIPAY_APP_ID: string;
  ALIPAY_PRIVATE_KEY: string;
  ALIPAY_PUBLIC_KEY: string;
  ALIPAY_SELLER_ID: string;
  ALIPAY_GATEWAY?: string;
  WECHAT_MCH_ID?: string;
  WECHAT_APP_ID?: string;
  WECHAT_SERIAL_NO?: string;
  WECHAT_PRIVATE_KEY?: string;
  WECHAT_API_V3_KEY?: string;
  WECHAT_PUBLIC_KEYS_JSON?: string;
  WECHAT_PUBLIC_KEY_ID?: string;
  WECHAT_CHANNELS?: string;
  GITHUB_TOKEN: string;
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  GITHUB_APP_INSTALLATION_ID?: string;
  REGISTRY_STORAGE_MODE?: string;
  GITHUB_REPOSITORY: string;
  GITHUB_BRANCH: string;
  CHECKOUT_SECRET: string;
  CLIENTS_JSON: string;
  REGISTRY_ENCRYPTION_KEY?: string;
  ADMIN_EMAIL?: string;
  ADMIN_PASSWORD_HASH?: string;
  ADMIN_PASSWORD_PEPPER?: string;
  ADMIN_SESSION_SECRET?: string;
  ADMIN_LOGIN_LIMITER?: {limit(options:{key:string}):Promise<{success:boolean}>};
  INTEGRATION_LIMITER?: {limit(options:{key:string}):Promise<{success:boolean}>};
  PAYMENT_API_LIMITER?: {limit(options:{key:string}):Promise<{success:boolean}>};
  LEGACY_WECHAT_CHECKOUT_SECRET?: string;
  LEGACY_WECHAT_BASE_URL?: string;
}
export interface ProductSku {
  subject: string;
  amount: string;
  enabled?: boolean;
  description?: string;
  /** Human-readable rule; fulfillment remains the product backend's responsibility. */
  entitlement?: string;
}
export interface ProductClient {
  id: string;
  name: string;
  apiSecret: string;
  webhookSecret: string;
  webhookUrl: string;
  returnOrigins: string[];
  skus: Record<string, ProductSku>;
  enabled?: boolean;
  providers?: PaymentProvider[];
  webhookProtocol?: 'brclio-v1' | 'wechat-legacy-v1';
  legacyWechat?: {id:string;[key:string]:unknown};
}
export interface Order {
  id: string;
  mode: 'live' | 'sandbox';
  /** Missing provider denotes a historical Alipay purchase. */
  provider?: PaymentProvider;
  /** Original 32-character WeChat merchant order number, retained on import. */
  wechatOrderId?: string;
  /** A purchase created through the old WeChat contract keeps that external identity. */
  legacyWechat?: {clientId:string;quantity:1;channel:'native';centerOrigin:string};
  clientId: string;
  productOrderId: string;
  sku: string;
  subject: string;
  amount: string;
  status: 'PENDING' | 'PAID' | 'CLOSED';
  createdAt: string;
  expiresAt: string;
  returnUrl: string;
  requestHash: string;
  tradeNo?: string;
  paidAt?: string;
  lastCheckedAt?: string;
  fulfillmentStatus: 'pending' | 'delivered';
  /** The purchase identity and original price/deadline stay immutable. A reopened
   * purchase uses a fresh Alipay out_trade_no and a separate ten-minute window. */
  activeAttemptId?: string;
  /** Marks orders whose signed checkout links have always been reserved. */
  attemptTrackingVersion?: 1;
  paymentAttempts?: PaymentAttempt[];
  adminOperation?: {requestId:string;token:string;action:'close'|'reopen'|'reconcile';expiresAt:string};
  recentActionIds?: string[];
  duplicatePayments?: {attemptId:string;tradeNo:string;paidAt:string;amount:string}[];
}
export interface PaymentAttempt {
  id:string;
  createdAt:string;
  expiresAt:string;
  status:Order['status'];
  linkIssuedAt?:string;
  /** Historical signed URLs may have a later deadline than today's policy. */
  linkExpiresAt?:string;
  closedAt?:string;
  /** A null query cannot invalidate a previously issued, uncreated payment URL. */
  closeConfirmed?:boolean;
  tradeNo?:string;
  paidAt?:string;
  /** Native payment parameters are private checkout data, never webhook data. */
  codeUrl?:string;
}
export interface PaymentEvent {
  id: string;
  type: 'payment.paid';
  mode: 'live' | 'sandbox';
  createdAt: string;
  data: {orderId: string; productOrderId: string; clientId: string; sku: string; amount: string; currency: 'CNY'; tradeNo: string; paidAt: string; provider?: PaymentProvider};
}
export interface Delivery {
  event: PaymentEvent;
  /** Freeze the external contract independently of later platform configuration changes. */
  webhookProtocol?: 'brclio-v1' | 'wechat-legacy-v1';
  webhookClientId?: string;
  attempts: number;
  nextAttemptAt: string;
  deliveredAt?: string;
  lastStatus?: number;
  leaseId?: string;
  leaseUntil?: string;
}
export interface WorkQueue { orders: string[]; deliveries: string[] }
export interface Transaction {
  read<T>(path: string): Promise<T | null>;
  put(path: string, value: unknown): void;
}
export interface Store {
  readJson<T>(path: string): Promise<T | null>;
  transaction<T>(callback: (tx: Transaction) => Promise<T>): Promise<T>;
  /** Immutable, bounded directory listing for administrator reporting/backfill. */
  openSnapshot?(): Promise<StoreSnapshot>;
}
export interface StoreSnapshot {
  revision: string;
  listJsonPaths(prefix: string): string[];
  readJson<T>(path: string): Promise<T | null>;
}

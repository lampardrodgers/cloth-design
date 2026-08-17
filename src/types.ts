export type ViewKey = "studio" | "free" | "workflows" | "account" | "storage";

export type ModeKey =
  | "text"
  | "free"
  | "tryon"
  | "fusion"
  | "campaign"
  | "product"
  | "fabric"
  | "lookbook";

export type ReferenceRole =
  | "model"
  | "garment"
  | "pose"
  | "scene"
  | "fabric"
  | "style";

export type ResolutionKey = "native" | "hd" | "fourK";
export type QualityKey = "auto" | "low" | "medium" | "high";
export type OutputFormat = "png" | "jpeg" | "webp";
export type BackgroundMode = "auto" | "opaque" | "transparent";
export type ModerationMode = "auto" | "low";
export type TaskStatus = "running" | "success" | "failed";
export type StorageStatus = "local-cache" | "cloud-temp" | "webdav" | "expired";

export interface GenerationMode {
  id: ModeKey;
  title: string;
  shortTitle: string;
  action: "generate" | "edit" | "compose";
  description: string;
  requiredRefs: ReferenceRole[];
  recommendedRefs: ReferenceRole[];
  baseCredits: number;
  promptStarter: string;
  systemTemplate: string;
}

export interface ReferenceImage {
  id: string;
  label: string;
  role: ReferenceRole;
  note: string;
  fileName?: string;
  previewUrl?: string;
  file?: File;
}

/**
 * 自由创作里每张附件的用途：
 * - reference 只借鉴风格/构图/配色，不要求原样出现在成片里；
 * - merge 图中主体必须真实出现在最终成片中。
 */
export type AttachmentUsage = "reference" | "merge";

export interface FreeAttachment {
  id: string;
  name: string;
  /** data:image/... 或 /generated-images/... ，两者都能直接再次送给图像引擎。 */
  previewUrl: string;
  usage: AttachmentUsage;
  note?: string;
  width?: number;
  height?: number;
  file?: File;
}

/** 从简易模式送到画布、等画布挂载后再落盘的图片。 */
export interface PendingCanvasImage {
  id: string;
  url: string;
  name: string;
}

export interface RatioOption {
  id: string;
  label: string;
  apiSize: "auto" | "1024x1024" | "1024x1536" | "1536x1024";
  width: number;
  height: number;
  allowedResolutions: ResolutionKey[];
  native: boolean;
}

export interface ResolutionOption {
  id: ResolutionKey;
  label: string;
  detail: string;
  apiNative: boolean;
}

export interface StudioSettings {
  mode: ModeKey;
  ratioId: string;
  resolution: ResolutionKey;
  quality: QualityKey;
  outputFormat: OutputFormat;
  background: BackgroundMode;
  moderation: ModerationMode;
  quantity: number;
  compression: number;
  inputFidelity: "standard" | "high";
  streamPreview: boolean;
  preserveIdentity: boolean;
}

export interface CreditPolicy {
  perReference: number;
  highQualityMultiplier: number;
  fourKMultiplier: number;
  transparentBackgroundFee: number;
  failureRefundRate: number;
}

export type SystemPromptMap = Record<ModeKey, string>;

export interface GenerationTask {
  id: string;
  mode: ModeKey;
  prompt: string;
  status: TaskStatus;
  progress: number;
  credits: number;
  createdAt: string;
  message: string;
}

export interface GeneratedResult {
  id: string;
  taskId: string;
  userId?: string;
  userEmail?: string;
  userName?: string;
  title: string;
  mode: ModeKey;
  ratioLabel: string;
  storageStatus: StorageStatus;
  credits: number;
  imageUrl: string;
  /** 生成这张图时用户写的那句描述（不是拼装后的完整提示词），用于回看和一键重做。 */
  prompt?: string;
  imageInspection?: Record<string, unknown>;
  qualityGate?: {
    status?: "passed" | "rework";
    score?: number;
    checks?: string[];
    warnings?: string[];
    issues?: string[];
    nextActions?: string[];
    normalization?: Record<string, unknown> | null;
  };
  createdAt: string;
}

export interface AccountUsage {
  taskCount: number;
  successCount: number;
  ownKeyTaskCount: number;
  taskCount30d: number;
  imageCount: number;
  creditsSpent: number;
  creditsSpent30d: number;
  lastActiveAt: string | null;
}

export interface UserAccount {
  id: string;
  email?: string;
  name: string;
  role: "owner" | "admin" | "user";
  plan: string;
  credits: number;
  monthlyUsed: number;
  status: "active" | "locked";
  /** 新账号默认待管理员开通；owner/admin 始终为 true。 */
  approved?: boolean;
  /** 账号自备了图像接口 Key（用它生成不扣积分）。 */
  hasOwnApiKey?: boolean;
  apiKeyHint?: string | null;
  apiKeyUpdatedAt?: string | null;
  /** 服务端 .env 里有没有共享 Key，账户页据此解释「不填也能用」。 */
  serverKeyConfigured?: boolean;
  /** 后台用量汇总（只在管理员总览里出现）。 */
  usage?: AccountUsage;
}

export interface RechargePackage {
  id: string;
  title: string;
  credits: number;
  price: number;
  amountCents?: number;
  badge: string;
  enabled?: boolean;
  sortOrder?: number;
}

export type PaymentProvider = "alipay" | "wechat";
export type PaymentOrderStatus = "pending" | "paid" | "closed" | "failed" | "refunded";

export interface PaymentOrder {
  id: string;
  packageId: string;
  provider: PaymentProvider;
  status: PaymentOrderStatus;
  amountCents: number;
  credits: number;
  subject: string;
  qrCodeUrl: string;
  qrCodeDataUrl: string;
  expiresAt: string;
  paidAt?: string | null;
  createdAt: string;
}

export interface CreditLedgerEntry {
  id: string;
  userId: string;
  orderId?: string | null;
  taskId?: string | null;
  kind: "recharge" | "consume" | "refund" | "admin_adjust";
  amount: number;
  balanceAfter: number;
  reason: string;
  createdBy?: string | null;
  createdAt: string;
}

export interface PaymentCapabilities {
  alipay: { enabled: boolean; demoMode: boolean; demoCompleteAllowed: boolean; ready?: boolean };
  wechat: { enabled: boolean; demoMode: boolean; demoCompleteAllowed: boolean; ready?: boolean };
}

export interface PaymentConfigStatus {
  alipay: { provider: "alipay"; enabled: boolean; demoMode: boolean; ready: boolean; missing: string[] };
  wechat: { provider: "wechat"; enabled: boolean; demoMode: boolean; ready: boolean; missing: string[] };
}

export interface ModelRoute {
  id: string;
  frontendCapability: string;
  provider: string;
  model: string;
  endpoint: string;
  enabled: boolean;
  defaultQuality: QualityKey;
  creditFormula: string;
}

export interface ImageProviderHealth {
  status: "demo" | "unknown" | "running" | "ok" | "usage_limited" | "no_token" | "timeout" | "error";
  label: string;
  blocking: boolean;
  message: string;
  resetAt?: string | null;
  checkedAt?: string | null;
}

export interface StoragePolicy {
  localCacheLimitGb: number;
  localCacheTtlHours: number;
  cloudTempTtlDays: number;
  webdavEnabled: boolean;
  webdavEndpoint: string;
  autoSyncOriginals: boolean;
  keepThumbnailsLocally: boolean;
  purgeFailedAfterHours: number;
}

export type WorkflowType = "fabric-to-style" | "virtual-model-showcase" | "postprocess-suite" | "trend-brand-lab";
export type WorkflowAssetKind = "fabric" | "sketch" | "garment" | "mannequin" | "designSketch" | "result" | "brand" | "reference";

export interface WorkflowDefinition {
  id: WorkflowType;
  title: string;
  inputTypes: string[];
  outputTypes: string[];
  capabilities: string[];
  capabilityStatus: Array<{
    id: string;
    label: string;
    status: "live" | "preview" | "requires_service";
    note: string;
    blocking?: boolean;
  }>;
}

export interface WorkflowAsset {
  id?: string;
  userId?: string;
  jobId?: string;
  kind: WorkflowAssetKind;
  name: string;
  mimeType: string;
  sourceUrl: string;
  note?: string;
  metadata?: Record<string, unknown>;
  createdAt?: string;
}

export interface CommercialModel {
  id: string;
  name: string;
  ethnicity: string;
  ageGroup: "adult" | "child" | "senior";
  bodyType: "standard" | "plus";
  gender: "female" | "male";
  commercialUse: boolean;
  poses: string[];
}

export interface WorkflowStep {
  id: string;
  jobId: string;
  position: number;
  title: string;
  capability: string;
  status: TaskStatus;
  message: string;
  metadata: Record<string, unknown>;
}

export interface WorkflowResult {
  id: string;
  jobId: string;
  assetId?: string | null;
  title: string;
  versionType: string;
  mediaType: "image" | "video" | "profile";
  imageUrl: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface TrendSignal {
  id: string;
  jobId: string;
  keyword: string;
  score: number;
  detail: string;
  createdAt?: string;
}

export interface BrandProfile {
  id: string;
  jobId: string;
  title: string;
  status: "ready" | "training" | "failed";
  dna: Record<string, unknown>;
  createdAt?: string;
}

export interface WorkflowJob {
  id: string;
  userId: string;
  type: WorkflowType;
  title: string;
  prompt: string;
  status: TaskStatus;
  progress: number;
  credits: number;
  message: string;
  options: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  assets: WorkflowAsset[];
  steps: WorkflowStep[];
  results: WorkflowResult[];
  trendSignals?: TrendSignal[];
  brandProfile?: BrandProfile | null;
}

export interface WorkflowDashboard {
  definitions: WorkflowDefinition[];
  commercialModels: CommercialModel[];
  jobs: WorkflowJob[];
  assets: WorkflowAsset[];
  trendSignals: TrendSignal[];
  brandProfiles: BrandProfile[];
  summary: {
    totalJobs: number;
    totalAssets: number;
    readyResults: number;
    activeBrandProfiles: number;
    quality: {
      passed: number;
      review: number;
      rework: number;
      unchecked: number;
    };
    productionReadiness: {
      provider: {
        mode: "demo" | "live";
        providerReady: boolean;
        baseUrl: string;
        model: string;
        health?: ImageProviderHealth;
      };
      runtime: {
        liveImageRequests: boolean;
        label: string;
      };
      capabilityCounts: {
        live: number;
        preview: number;
        requiresService: number;
      };
      blockers: Array<{
        workflowId: WorkflowType;
        workflowTitle: string;
        capabilityId: string;
        label: string;
        note: string;
        service: string;
        requiredEnv: string[];
        configured: boolean;
        nextAction: string;
      }>;
      optionalServices: Array<{
        workflowId: WorkflowType;
        workflowTitle: string;
        capabilityId: string;
        label: string;
        note: string;
        service: string;
        requiredEnv: string[];
        configured: boolean;
        nextAction: string;
      }>;
    };
  };
}

export type ViewKey = "studio" | "account" | "storage";

export type ModeKey =
  | "text"
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
  title: string;
  mode: ModeKey;
  ratioLabel: string;
  storageStatus: StorageStatus;
  credits: number;
  imageUrl: string;
  createdAt: string;
}

export interface UserAccount {
  id: string;
  name: string;
  role: "owner" | "designer" | "operator";
  plan: string;
  credits: number;
  monthlyUsed: number;
  status: "active" | "locked";
}

export interface RechargePackage {
  id: string;
  title: string;
  credits: number;
  price: number;
  badge: string;
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

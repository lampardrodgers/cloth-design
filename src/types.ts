export type ViewKey = "studio" | "free" | "workflows" | "account" | "storage" | "shortvideo";

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
export type ProviderProtocol = "openai" | "apimart";
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
  /** 「原图 + 人工标注」拍平成的图：提示词里要交代箭头是修改指令，不是画面内容。 */
  annotated?: boolean;
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
  apiSize: string;
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
  /** 开始/结束的毫秒时间戳。createdAt 只是「14:32」这样的显示文案，算不出跑了多久。 */
  startedAt?: number;
  finishedAt?: number;
  message: string;
}

/** 一次提交当时的现场：描述、参考图、参数。提交完输入框会清空，靠它回看。 */
export interface SubmissionReference {
  name: string;
  usage: AttachmentUsage;
  /** 缩略图（长边 128px）。存全尺寸会把 localStorage 撑爆，认出是哪张图足够。 */
  thumbUrl: string;
}

export interface SubmissionRecord {
  taskId: string;
  /** 用户写的那句描述，不是拼装后的完整提示词。 */
  prompt: string;
  references: SubmissionReference[];
  ratioLabel: string;
  sizeLabel: string;
  quantity: number;
  quality: string;
  outputFormat: string;
  background: string;
  inputFidelity: string;
  createdAt: string;
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
  /** 服务器暂存到期时间；已过期为 null。 */
  expiresAt?: string | null;
  expiredAt?: string | null;
  /** 推到 WebDAV 云盘的时间和远程路径。 */
  archivedAt?: string | null;
  archivePath?: string | null;
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
  /** 对外显示的账号名（内部邮箱去掉 @clothdesign.local）。 */
  username?: string;
  name: string;
  role: "owner" | "admin" | "user";
  plan: string;
  credits: number;
  monthlyUsed: number;
  status: "active" | "locked";
  /** 新账号默认待管理员开通；owner/admin 始终为 true。 */
  approved?: boolean;
  /** 管理员开的「无限额度」：生成不扣积分，顶栏显示 ∞。 */
  unlimited?: boolean;
  /** 账号自备了图像接口 Key（用它生成不扣积分）。 */
  hasOwnApiKey?: boolean;
  apiKeyHint?: string | null;
  apiKeyUpdatedAt?: string | null;
  /** 这把自备 Key（或共享 Key）要配对的 URL Base。 */
  apiProviderId?: string;
  /** 当前线路的显示名和协议，界面上要照实说是哪条线。 */
  apiProviderName?: string;
  apiProviderProtocol?: ProviderProtocol;
  /** 这个账号最高能出到哪一档（线路能力与后台上限取低）。 */
  maxResolution?: ResolutionKey;
  /** 后台按账号设的上限原值；空串 = 跟随线路。 */
  maxResolutionSetting?: ResolutionKey | "";
  /** 上限是线路给的（provider）还是后台压的（account）。 */
  maxResolutionSource?: "provider" | "account";
  /** 服务端 .env 里有没有共享 Key，账户页据此解释「不填也能用」。 */
  serverKeyConfigured?: boolean;
  /** 后台用量汇总（只在管理员总览里出现）。 */
  usage?: AccountUsage;
  /** 按账号开的功能开关；前端只在为 true 时渲染对应入口。 */
  features?: AccountFeatures;
  /** 后台总览里才有：短视频是不是单独给这个账号打开了（admin 天然可用，不看这个）。 */
  shortVideoEnabled?: boolean;
  canUseShortVideo?: boolean;
}

export interface AccountFeatures {
  /** 短视频模块：默认只有 admin；后台可按账号打开。 */
  shortVideo: boolean;
}

export interface ImageProviderOption {
  id: string;
  name: string;
  protocol: ProviderProtocol;
  baseUrl: string;
  model: string;
  /** 这条线路本身最高能出到哪一档。 */
  maxResolution?: ResolutionKey;
  serverKeyConfigured?: boolean;
}

/**
 * 当前账号的出图能力：分辨率能点到哪一档、像素怎么算，都看这个。
 * 由服务端按「线路能力 + 后台按账号设的上限」算好后下发。
 */
export interface ProviderCapability {
  providerName: string;
  protocol: ProviderProtocol;
  maxResolution: ResolutionKey;
  maxResolutionSource: "provider" | "account";
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

/** 账号自己的 WebDAV 云盘配置（服务端存，密码不回传）。 */
export interface StorageSettings {
  webdavUrl: string;
  webdavUsername: string;
  webdavDirectory: string;
  webdavEnabled: boolean;
  autoArchive: boolean;
  hasPassword: boolean;
  lastError: string | null;
  lastErrorAt: string | null;
  lastArchivedAt: string | null;
  updatedAt: string | null;
}

/** 文件管理页的概况：服务器暂存固定天数 + 各状态数量。 */
export interface StorageOverview {
  retentionDays: number;
  active: number;
  archived: number;
  expired: number;
  expiredBackedUp: number;
  settings: StorageSettings;
}

/** 这台电脑上的本地文件夹设置（只存在浏览器里）。 */
export interface LocalFolderPolicy {
  autoSave: boolean;
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

/* ── 短视频（MoneyPrinterTurbo 引擎） ─────────────────────────────────────── */

export type ShortVideoStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface ShortVideoOption {
  id: string;
  label: string;
  hint?: string;
}

export interface ShortVideoAspectOption extends ShortVideoOption {
  width: number;
  height: number;
}

export interface ShortVideoVoiceOption extends ShortVideoOption {
  locale: string;
}

export interface ShortVideoOptions {
  aspects: ShortVideoAspectOption[];
  languages: ShortVideoOption[];
  voices: ShortVideoVoiceOption[];
  fonts: ShortVideoOption[];
  subtitlePositions: ShortVideoOption[];
  concatModes: ShortVideoOption[];
  transitions: ShortVideoOption[];
  sources: ShortVideoOption[];
  bgm: ShortVideoOption[];
  platforms: ShortVideoOption[];
  stages: Record<string, string>;
  limits: {
    maxActivePerUser: number;
    maxScriptChars: number;
    maxCount: number;
    clipDuration: [number, number];
    clipSpeed: [number, number];
    paragraphs: [number, number];
    customPosition: [number, number];
    materialMaxBytes: number;
    musicMaxBytes: number;
    maxScriptPromptChars: number;
    /** 服务器上的保留期：上传的素材 / 音乐按小时、成片按天（和生成图一致）。 */
    retention?: { uploadHours: number; outputDays: number };
  };
}

/** 成片在服务器上的去留，和生成图一套词：cloud-temp（暂存）/ webdav（已推云盘）/ expired（已到期清理）。 */
export interface MediaStorageInfo {
  status: "cloud-temp" | "webdav" | "expired" | string;
  expiresAt: string | null;
  archivedAt: string | null;
  archivePath: string | null;
  expiredAt: string | null;
  retentionDays: number;
}

export interface ShortVideoMetadata {
  title: string;
  caption: string;
  hashtags: string[];
}

export interface ShortVideoEngineStatus {
  configured: boolean;
  online: boolean;
  url: string;
  checkedAt: string;
  latencyMs: number | null;
  error: string | null;
}

export interface ShortVideoLlmStatus {
  configured: boolean;
  demo: boolean;
  model: string;
  source: "shortvideo" | "image-provider";
}

export interface ShortVideoFile {
  name: string;
  size: number;
  /** 本站上传的文件会带上：什么时候传的、几点自动清理、是不是我传的。引擎自带的没有。 */
  uploadedAt?: string;
  expiresAt?: string;
  mine?: boolean;
  originalName?: string;
}

/** 创建任务的请求体；服务端会再规范化一遍。 */
export interface ShortVideoRequest {
  subject: string;
  script: string;
  terms: string[];
  language: string;
  aspect: string;
  clipDuration: number;
  /** 片段倍速 0.5–2，素材偏拖沓时提一点节奏。 */
  clipSpeed: number;
  /** 素材按文案顺序匹配（会强制顺序拼接）。 */
  matchScript: boolean;
  /** 让 AI 写几段。 */
  paragraphs: number;
  /** 写文案时的额外要求，只影响本站这边的模型。 */
  scriptPrompt: string;
  concatMode: string;
  transition: string;
  count: number;
  source: string;
  materials: string[];
  voice: string;
  voiceRate: number;
  voiceVolume: number;
  bgm: { type: string; file: string; volume: number };
  subtitle: {
    enabled: boolean;
    position: string;
    /** 位置选「自定义高度」时的距顶百分比。 */
    customPosition: number;
    font: string;
    size: number;
    color: string;
    strokeColor: string;
    strokeWidth: number;
    /** 字幕底色：亮素材上白字看不清时打开。 */
    background: { enabled: boolean; color: string; rounded: boolean };
  };
}

export interface ShortVideoTask {
  id: string;
  storage?: MediaStorageInfo;
  status: ShortVideoStatus;
  progress: number;
  stage: string;
  stageLabel: string;
  subject: string;
  script: string;
  terms: string[];
  params: Partial<ShortVideoRequest>;
  result: {
    videos: Array<{ name: string; bytes: number; url: string }>;
    subtitle: string | null;
    audioDuration: number | null;
    warnings: string[] | null;
  };
  error: string | null;
  failureSource: "engine" | "system" | null;
  credits: number;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

/* 后台：短视频接口配置 */

export interface ShortVideoAdminSettings {
  llmProviderId: string;
  llmBaseUrl: string;
  llmModel: string;
  llmApiKeyConfigured: boolean;
  llmApiKeyHint: string;
  llmApiKeySource: "admin" | "env" | "provider";
  maxActivePerUser: number;
  providers: Array<{ id: string; name: string }>;
  sources: Record<string, string>;
  updatedAt: string | null;
}

export interface ShortVideoEngineConfigField {
  id: string;
  label: string;
  group: "material" | "voice" | "engine";
  kind: "secret" | "secretList" | "enum" | "int" | "text" | "bool";
  hint: string;
  docs: string;
  options: string[] | null;
  present: boolean;
  configured: boolean;
  /** 明文项（枚举 / 数字 / 普通文本）才有值；Key 一律空串。 */
  value: string | number | boolean;
  /** secret：脱敏提示；secretList：个数。 */
  hint2?: string;
  count?: number;
}

export interface ShortVideoEngineConfig {
  editable: boolean;
  restartAvailable: boolean;
  path: string;
  fields: ShortVideoEngineConfigField[];
  error: string | null;
}

export interface ShortVideoAdminOverview {
  engine: ShortVideoEngineStatus;
  llm: ShortVideoLlmStatus;
  settings: ShortVideoAdminSettings;
  engineConfig: ShortVideoEngineConfig;
  activeTasks: number;
}

/* ── Seedance（火山方舟视频生成） ─────────────────────────────────────────── */

export type SeedanceMode = "text" | "image" | "omni";
export type SeedanceStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "expired";
export type SeedanceRefKind = "image" | "video" | "audio";

export interface SeedanceOption {
  id: string;
  label: string;
  hint: string;
}

export interface SeedanceRatioOption extends SeedanceOption {
  w: number;
  h: number;
}

/** 服务端下发的模型能力矩阵：界面按它决定哪些参数能调、哪些藏起来。 */
export interface SeedanceModel {
  id: string;
  name: string;
  family: string;
  status: "active" | "retiring";
  blurb: string;
  priceHint: string;
  resolutions: string[];
  defaultResolution: string;
  duration: { min: number; max: number; smart: boolean };
  frames: boolean;
  audio: boolean;
  seed: boolean;
  cameraFixed: boolean;
  draft: boolean;
  serviceTiers: string[];
  priority: boolean;
  outputFormats: string[];
  webSearch: boolean;
  omniTaskType: boolean;
  modes: SeedanceMode[];
  lastFrame: boolean;
  textAdaptive: boolean;
  imageAdaptiveOnly: boolean;
  omni: { images: number; videos: number; audios: number; audioOnly: boolean; videoSeconds: number; audioSeconds: number; clipSeconds: [number, number] } | null;
}

export interface SeedanceOptions {
  modes: SeedanceOption[];
  models: SeedanceModel[];
  defaultModel: string;
  ratios: SeedanceRatioOption[];
  resolutions: SeedanceOption[];
  outputFormats: SeedanceOption[];
  serviceTiers: SeedanceOption[];
  omniTaskTypes: SeedanceOption[];
  /** 中间帧的两种落地法：reference（2.x 参考图一镜到底）/ segments（分段接力 + 自动合并）。 */
  keyframeStrategies: SeedanceOption[];
  statusLabels: Record<string, string>;
  limits: {
    maxActivePerUser: number;
    maxPromptChars: number;
    maxCount: number;
    /** 首帧 + 中间帧 + 尾帧最多几张。 */
    maxKeyframes: number;
    retention: { uploadHours: number; outputDays: number };
    expiresAfter: [number, number];
    frames: [number, number];
    seedMax: number;
    priority: [number, number];
    refMaxBytes: Record<SeedanceRefKind, number>;
    refExts: Record<SeedanceRefKind, string[]>;
    imagePx: [number, number];
    imageRatio: [number, number];
  };
}

export interface SeedanceStatusInfo {
  configured: boolean;
  online: boolean;
  latencyMs?: number;
  error: string;
  baseUrl: string;
  keySource: "admin" | "env" | "none";
  /** 参考视频 / 音频要靠公网地址给方舟；没配就只能用图片（走 base64）。 */
  publicMediaReady: boolean;
}

export interface SeedanceRef {
  id: string;
  kind: SeedanceRefKind;
  ext: string;
  mime: string;
  name: string;
  bytes: number;
  width: number | null;
  height: number | null;
  durationSeconds: number | null;
  source: "upload" | "last_frame";
  url: string;
  createdAt: string;
}

/** 一个素材槽位：要么是已上传素材的编号，要么是一个公网链接。 */
export interface SeedanceMediaSlot {
  refId?: string;
  url?: string;
  kind?: SeedanceRefKind;
  name?: string | null;
}

export interface SeedanceRequest {
  model: string;
  mode: SeedanceMode;
  prompt: string;
  firstFrame: SeedanceMediaSlot | null;
  lastFrame: SeedanceMediaSlot | null;
  /** 中间帧（按时间顺序）；方舟本身只认首尾帧，靠 keyframeStrategy 落地。 */
  middleFrames: SeedanceMediaSlot[];
  keyframeStrategy: "reference" | "segments";
  references: Array<SeedanceMediaSlot & { kind: SeedanceRefKind }>;
  omniTaskType: string;
  ratio: string;
  resolution: string;
  /** -1 = 智能时长（模型自己定）。 */
  duration: number;
  /** 只有 1.0 系列支持；填了就按帧数算、忽略秒数。 */
  frames: number | null;
  generateAudio: boolean;
  watermark: boolean;
  seed: number;
  cameraFixed: boolean;
  returnLastFrame: boolean;
  outputFormat: string;
  serviceTier: string;
  priority: number;
  draft: boolean;
  webSearch: boolean;
  expiresAfter: number;
  count: number;
  draftTaskId?: string | null;
}

export interface SeedanceTaskFile {
  name: string;
  bytes: number;
  url: string;
  format?: string;
}

export interface SeedanceGroup {
  id: string;
  strategy: string;
  total: number;
  /** 这条任务是第几段（从任务卡上看时才有）。 */
  index: number | null;
  completed: number;
  failed: number;
  present: number;
  status: "pending" | "merging" | "merged" | "failed" | "partial";
  error: string | null;
  merged: { name: string; bytes: number; url: string; durationSeconds: number | null } | null;
  mergedExpiredAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SeedanceTask {
  id: string;
  arkTaskId: string | null;
  /** 还没交给方舟、在本站排队（分段接力超出并发的那几段）。 */
  pendingSubmit: boolean;
  model: string;
  modelName: string;
  mode: SeedanceMode;
  status: SeedanceStatus;
  statusLabel: string;
  prompt: string;
  group: SeedanceGroup | null;
  storage: MediaStorageInfo;
  params: Partial<SeedanceRequest> & { ratioLocked?: boolean; modelName?: string };
  content: Array<{ type: string; role?: string; refId?: string | null; url?: string | null; name?: string | null; text?: string; id?: string }>;
  result: {
    video: SeedanceTaskFile | null;
    lastFrame: SeedanceTaskFile | null;
    remoteVideoUrl: string | null;
    duration: number | null;
    frames: number | null;
    fps: number | null;
    resolution: string | null;
    ratio: string | null;
    seed: number | null;
    generateAudio: boolean | null;
    outputFormat: string | null;
    draft: boolean | null;
    usage: { completionTokens: number; totalTokens: number; webSearch: number | null } | null;
    arkModel: string | null;
  };
  error: string | null;
  errorCode: string | null;
  credits: number;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

export interface SeedanceAdminSettings {
  apiKeyConfigured: boolean;
  apiKeyHint: string;
  apiKeySource: "admin" | "env" | "none";
  baseUrl: string;
  defaultModel: string;
  maxActivePerUser: number;
  publicBaseUrl: string;
  enabledModels: string[];
  sources: Record<"baseUrl" | "defaultModel" | "maxActivePerUser" | "publicBaseUrl" | "enabledModels", "admin" | "env">;
  updatedAt: string | null;
}

export interface SeedanceArkModel {
  id: string;
  name: string;
  status: string;
  version: string;
  taskTypes: string[];
  inputs: string[];
  inCatalog: boolean;
}

export interface SeedanceModelAccess {
  model: string;
  /** ok = 能调；unauthorized = Key 没这个模型的权限；not_open = 没开通；unknown = 方舟不认识；error = 没探到。 */
  access: "ok" | "unauthorized" | "not_open" | "unknown" | "error";
  detail: string;
  latencyMs: number;
}

export interface SeedanceAdminOverview {
  status: SeedanceStatusInfo;
  settings: SeedanceAdminSettings;
  models: SeedanceModel[];
  activeTasks: number;
}

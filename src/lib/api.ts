import type {
  CreditLedgerEntry,
  GeneratedResult,
  GenerationMode,
  ImageProviderOption,
  PaymentCapabilities,
  PaymentConfigStatus,
  PaymentOrder,
  PaymentProvider,
  ProviderProtocol,
  RechargePackage,
  ReferenceImage,
  ResolutionKey,
  StorageOverview,
  StudioSettings,
  UserAccount,
  WorkflowAsset,
  WorkflowDashboard,
  WorkflowJob,
  WorkflowType,
  ShortVideoEngineStatus,
  ShortVideoFile,
  ShortVideoLlmStatus,
  ShortVideoOptions,
  ShortVideoRequest,
  ShortVideoTask,
  ShortVideoAdminOverview,
  ShortVideoAdminSettings,
  ShortVideoEngineConfig,
  ShortVideoMetadata,
  SeedanceAdminOverview,
  SeedanceGroup,
  SeedanceModelAccess,
  SeedanceAdminSettings,
  SeedanceArkModel,
  SeedanceOptions,
  SeedanceRef,
  SeedanceRequest,
  SeedanceStatusInfo,
  SeedanceTask,
} from "../types";

export interface ApiConfig {
  mode: "demo" | "live";
  providerReady: boolean;
  imageModelConfigured: boolean;
  providerHealth?: import("../types").ImageProviderHealth;
  authEnabled: boolean;
  selfSignupAllowed?: boolean;
  debugUnlimitedAvailable?: boolean;
  /** 服务器暂存成片的天数（服务端写死）。 */
  storageRetentionDays?: number;
  port: number;
  imageProviders?: ImageProviderOption[];
}

export interface ImageProviderTestResponse {
  ok: boolean;
  label: string;
  message: string;
  providerId?: string;
  keySource?: "user" | "server" | null;
}

export interface StorageAdminOverview {
  retentionDays: number;
  directory: string;
  fileCount: number;
  diskBytes: number;
  active: number;
  archived: number;
  expired: number;
  backedUp: number;
  webdavUsers: number;
  lastMaintenance: {
    ranAt: string;
    expired: number;
    filesDeleted: number;
    bytesFreed: number;
    keptReferenced: number;
    orphansDeleted: number;
  } | null;
}

/** 分页列表的统一形状：服务端把总数和总页数一起给，前端不用自己猜还有没有下一页。 */
export interface PageInfo {
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
}

export interface PagedList<T> extends PageInfo {
  items: T[];
}

export interface StorageResponse {
  overview: StorageOverview;
  results: GeneratedResult[];
  resultsPagination?: PageInfo;
}

export interface GenerateApiResult {
  imageUrl: string;
  revisedPrompt?: string;
  index: number;
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
}

export interface GenerateApiResponse extends ApiConfig {
  results: GenerateApiResult[];
  message: string;
  taskId?: string;
  credits?: number;
  account?: UserAccount;
  error?: string;
}

export interface MeResponse {
  account: UserAccount;
  packages: RechargePackage[];
  orders: PaymentOrder[];
  ledger: CreditLedgerEntry[];
  generationResults: GeneratedResult[];
  debugUnlimited?: boolean;
  paymentCapabilities: PaymentCapabilities;
  paymentConfig: PaymentConfigStatus;
  imageProviders: ImageProviderOption[];
}

export interface AdminSummary {
  users: { total: number; pending: number; locked: number; unlimited: number; withOwnKey: number; active24h: number };
  tasks: { total: number; last24h: number; failed: number; failed24h: number };
  images: { total: number; last24h: number };
  creditsSpent30d: number;
  selfSignupAllowed: boolean;
}

export interface ImageProviderSettings {
  id: string;
  name: string;
  protocol: ProviderProtocol;
  /** 这条线路本身最高能出到哪一档（1K / 2K / 4K）。 */
  maxResolution?: ResolutionKey;
  baseUrl: string;
  model: string;
  baseUrlSource: "env" | "custom";
  modelSource: "env" | "custom";
  defaults: { baseUrl: string; model: string };
  updatedAt: string | null;
  serverKeyConfigured?: boolean;
  serverKeyHint?: string | null;
  serverKeySource?: "admin" | "env" | "none";
  serverKeyUpdatedAt?: string | null;
}

export interface AdminOverviewResponse {
  summary?: AdminSummary;
  imageProvider?: ImageProviderSettings;
  imageProviders?: ImageProviderSettings[];
  users: UserAccount[];
  packages: RechargePackage[];
  orders: PaymentOrder[];
  paymentEvents: Array<{
    id: string;
    provider: PaymentProvider;
    eventKey: string;
    orderId?: string | null;
    transactionId?: string | null;
    processed: boolean;
    createdAt: string;
  }>;
  ledger: CreditLedgerEntry[];
  generationResults: GeneratedResult[];
  /** 上面几个数组只是各自的第一页；这里给每个列表的总数和页数，翻页走下面的分页接口。 */
  pagination?: {
    users: PageInfo;
    orders: PageInfo;
    paymentEvents: PageInfo;
    ledger: PageInfo;
    generationResults: PageInfo;
  };
  paymentCapabilities: PaymentCapabilities;
  paymentConfig: PaymentConfigStatus;
  storage?: StorageAdminOverview;
}

export type AdminPaymentEvent = AdminOverviewResponse["paymentEvents"][number];

export interface AdminListQuery {
  page?: number;
  pageSize?: number;
  /** 只有用户列表用得上：按账号名 / 显示名搜。 */
  q?: string;
  filter?: string;
}

function pageQuery(query: AdminListQuery = {}) {
  const params = new URLSearchParams();
  if (query.page) params.set("page", String(query.page));
  if (query.pageSize) params.set("pageSize", String(query.pageSize));
  if (query.q) params.set("q", query.q);
  if (query.filter && query.filter !== "all") params.set("filter", query.filter);
  const text = params.toString();
  return text ? `?${text}` : "";
}

async function parseJson<T>(response: Response): Promise<T> {
  const data = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok || data.error) {
    throw new Error(data.error || `请求失败: ${response.status}`);
  }
  return data as T;
}

export function reusableReferenceUrl(previewUrl?: string) {
  if (!previewUrl) return undefined;
  if (previewUrl.startsWith("http://") || previewUrl.startsWith("https://") || previewUrl.startsWith("data:image/")) {
    return previewUrl;
  }
  if (previewUrl.startsWith("/generated-images/")) {
    return previewUrl;
  }
  return undefined;
}

function workflowAssetName(result: Pick<GeneratedResult, "title" | "imageUrl" | "id">) {
  const extension = result.imageUrl.match(/\.(png|jpe?g|webp)(?:$|\?)/i)?.[1]?.replace(/^jpg$/i, "jpeg") ?? "png";
  const stem =
    String(result.title || result.id || "generated-result")
      .replace(/[^\w.\-\u4e00-\u9fa5]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 72) || "generated-result";
  return /\.(png|jpe?g|webp)$/i.test(stem) ? stem : `${stem}.${extension === "jpeg" ? "jpg" : extension}`;
}

function workflowAssetMimeType(sourceUrl: string) {
  const dataMime = sourceUrl.match(/^data:(image\/[^;,]+)/)?.[1];
  if (dataMime) return dataMime;
  if (/\.jpe?g(?:$|\?)/i.test(sourceUrl)) return "image/jpeg";
  if (/\.webp(?:$|\?)/i.test(sourceUrl)) return "image/webp";
  return "image/png";
}

function metadataStringField(metadata: Record<string, unknown> | undefined, key: string, nestedKey?: string) {
  const value = metadata?.[key];
  if (nestedKey && value && typeof value === "object" && !Array.isArray(value)) {
    const nestedValue = (value as Record<string, unknown>)[nestedKey];
    return typeof nestedValue === "string" ? nestedValue : undefined;
  }
  return typeof value === "string" ? value : undefined;
}

export function generatedResultsToWorkflowAssets(
  results: GeneratedResult[] = [],
  options: { max?: number; notePrefix?: string } = {},
): WorkflowAsset[] {
  const max = Math.max(1, Math.trunc(options.max ?? 2));
  const notePrefix = options.notePrefix ?? "已生成结果";
  const assets: WorkflowAsset[] = [];
  for (const result of results) {
    if (result.qualityGate?.status === "rework") continue;
    const sourceUrl = reusableReferenceUrl(result.imageUrl);
    if (!sourceUrl) continue;
    assets.push({
      kind: "result",
      name: workflowAssetName(result),
      mimeType: workflowAssetMimeType(sourceUrl),
      sourceUrl,
      note: `${notePrefix} · ${result.mode}`,
    });
    if (assets.length >= max) break;
  }
  return assets;
}

export function workflowResultsToWorkflowAssets(
  jobs: Array<Pick<WorkflowJob, "type" | "results">> = [],
  options: { max?: number; notePrefix?: string } = {},
): WorkflowAsset[] {
  const max = Math.max(1, Math.trunc(options.max ?? 2));
  const notePrefix = options.notePrefix ?? "功能中心前序结果";
  const assets: WorkflowAsset[] = [];
  for (const job of jobs) {
    if (job.type === "postprocess-suite") continue;
    for (const result of job.results ?? []) {
      if (result.mediaType !== "image") continue;
      if (metadataStringField(result.metadata, "qualityGate", "status") === "rework") continue;
      const sourceUrl = reusableReferenceUrl(result.imageUrl);
      if (!sourceUrl) continue;
      const mode = metadataStringField(result.metadata, "generationMode") ?? result.versionType;
      assets.push({
        kind: "result",
        name: workflowAssetName({ title: result.title, imageUrl: result.imageUrl, id: result.id }),
        mimeType: workflowAssetMimeType(sourceUrl),
        sourceUrl,
        note: `${notePrefix} · ${job.type} · ${mode}`,
      });
      if (assets.length >= max) return assets;
    }
  }
  return assets;
}

export async function fetchApiConfig(): Promise<ApiConfig> {
  const response = await fetch("/api/config", { credentials: "include" });
  return parseJson<ApiConfig>(response);
}

export async function fetchMe(): Promise<MeResponse> {
  const response = await fetch("/api/me", { credentials: "include" });
  return parseJson<MeResponse>(response);
}

export async function testMyImageProvider(): Promise<ImageProviderTestResponse> {
  const response = await fetch("/api/me/image-provider/test", {
    method: "POST",
    credentials: "include",
  });
  return parseJson<ImageProviderTestResponse>(response);
}

export async function startDebugSession() {
  const response = await fetch("/api/debug/session", {
    method: "POST",
    credentials: "include",
  });
  return parseJson<{ debugUnlimited: boolean }>(response);
}

export async function endDebugSession() {
  const response = await fetch("/api/debug/session", {
    method: "DELETE",
    credentials: "include",
  });
  return parseJson<{ debugUnlimited: boolean }>(response);
}

export async function signInEmail(email: string, password: string) {
  const response = await fetch("/api/auth/sign-in/email", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ email, password }),
  });
  return parseJson(response);
}

export async function signUpEmail(name: string, email: string, password: string) {
  const response = await fetch("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ name, email, password }),
  });
  return parseJson(response);
}

export async function saveMyApiKey(apiKey: string, providerId?: string) {
  const response = await fetch("/api/me/api-key", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ apiKey, providerId }),
  });
  return parseJson<{ account: UserAccount }>(response);
}

export async function selectMyImageProvider(providerId: string) {
  const response = await fetch("/api/me/image-provider", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ providerId }),
  });
  return parseJson<{ account: UserAccount }>(response);
}

export async function clearMyApiKey() {
  const response = await fetch("/api/me/api-key", { method: "DELETE", credentials: "include" });
  return parseJson<{ account: UserAccount }>(response);
}

export async function signOut() {
  const response = await fetch("/api/auth/sign-out", {
    method: "POST",
    credentials: "include",
  });
  return parseJson(response);
}

export async function createPaymentOrder(packageId: string, provider: PaymentProvider) {
  const response = await fetch("/api/payments/orders", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ packageId, provider }),
  });
  return parseJson<{ order: PaymentOrder; paymentCapabilities: PaymentCapabilities }>(response);
}

export async function fetchPaymentOrder(id: string) {
  const response = await fetch(`/api/payments/orders/${encodeURIComponent(id)}`, { credentials: "include" });
  return parseJson<{ order: PaymentOrder; account: UserAccount; ledger: CreditLedgerEntry[] }>(response);
}

export async function completeDemoPayment(id: string) {
  const response = await fetch(`/api/test/payments/${encodeURIComponent(id)}/complete`, {
    method: "POST",
    credentials: "include",
  });
  return parseJson<{ order: PaymentOrder; account: UserAccount; ledger: CreditLedgerEntry[] }>(response);
}

export async function fetchAdminOverview(): Promise<AdminOverviewResponse> {
  const response = await fetch("/api/admin/overview", { credentials: "include" });
  return parseJson<AdminOverviewResponse>(response);
}

async function fetchAdminPage<T>(path: string, query: AdminListQuery): Promise<PagedList<T>> {
  const response = await fetch(`${path}${pageQuery(query)}`, { credentials: "include" });
  return parseJson<PagedList<T>>(response);
}

export const fetchAdminUsersPage = (query: AdminListQuery = {}) => fetchAdminPage<UserAccount>("/api/admin/users", query);
export const fetchAdminOrdersPage = (query: AdminListQuery = {}) => fetchAdminPage<PaymentOrder>("/api/admin/orders", query);
export const fetchAdminPaymentEventsPage = (query: AdminListQuery = {}) =>
  fetchAdminPage<AdminPaymentEvent>("/api/admin/payment-events", query);
export const fetchAdminLedgerPage = (query: AdminListQuery = {}) => fetchAdminPage<CreditLedgerEntry>("/api/admin/ledger", query);
export const fetchAdminGenerationResultsPage = (query: AdminListQuery = {}) =>
  fetchAdminPage<GeneratedResult>("/api/admin/generation-results", query);

export async function deleteGenerationResult(id: string) {
  const response = await fetch(`/api/generation-results/${encodeURIComponent(id)}`, {
    method: "DELETE",
    credentials: "include",
  });
  return parseJson<{ deleted: boolean; id: string; file?: { deleted?: boolean; fileName?: string; reason?: string } | null }>(response);
}

export async function fetchStorage(query: AdminListQuery = {}) {
  const response = await fetch(`/api/me/storage${pageQuery(query)}`, { credentials: "include" });
  return parseJson<StorageResponse>(response);
}

export interface WebdavSettingsInput {
  webdavUrl?: string;
  webdavUsername?: string;
  /** 不传 = 不改密码；空串 = 清掉。 */
  webdavPassword?: string;
  webdavDirectory?: string;
  webdavEnabled?: boolean;
  autoArchive?: boolean;
}

export async function saveWebdavSettings(input: WebdavSettingsInput) {
  const response = await fetch("/api/me/storage/webdav", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(input),
  });
  return parseJson<{ overview: StorageOverview }>(response);
}

export async function testWebdavSettings(input: WebdavSettingsInput) {
  const response = await fetch("/api/me/storage/webdav/test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(input),
  });
  return parseJson<{ ok: boolean; message: string }>(response);
}

/** 把一张成片推到账号自己的 WebDAV 云盘。 */
export async function archiveGenerationResult(id: string) {
  const response = await fetch(`/api/generation-results/${encodeURIComponent(id)}/archive`, {
    method: "POST",
    credentials: "include",
  });
  return parseJson<{ result: GeneratedResult }>(response);
}

export async function archiveAllGenerationResults(query: AdminListQuery = {}) {
  // 归档完顺手把当前这一页重新取回来，别把用户甩回第一页。
  const response = await fetch(`/api/me/storage/archive-all${pageQuery(query)}`, { method: "POST", credentials: "include" });
  return parseJson<StorageResponse & { summary: { attempted: number; archived: number; failed: number; errors: string[] } }>(response);
}

export async function runAdminStorageMaintenance() {
  const response = await fetch("/api/admin/storage/maintenance", { method: "POST", credentials: "include" });
  return parseJson<{ summary: NonNullable<StorageAdminOverview["lastMaintenance"]>; storage: StorageAdminOverview }>(response);
}

export async function updateAdminUser(id: string, patch: Partial<UserAccount>) {
  const response = await fetch(`/api/admin/users/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(patch),
  });
  return parseJson<{ user: UserAccount }>(response);
}

export async function createAdminUser(input: {
  username: string;
  password: string;
  name?: string;
  apiKey?: string;
  unlimited?: boolean;
  credits?: number;
  apiProviderId?: string;
}) {
  const response = await fetch("/api/admin/users", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(input),
  });
  return parseJson<{ user: UserAccount }>(response);
}

export async function saveImageProvider(input: { providerId?: string; baseUrl?: string; model?: string; apiKey?: string }) {
  const response = await fetch("/api/admin/image-provider", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(input),
  });
  return parseJson<{ imageProvider: ImageProviderSettings }>(response);
}

export async function clearImageProviderApiKey(providerId = "default") {
  const response = await fetch("/api/admin/image-provider/key", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ providerId }),
  });
  return parseJson<{ imageProvider: ImageProviderSettings }>(response);
}

export async function resetImageProvider(providerId = "default") {
  const response = await fetch("/api/admin/image-provider", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ providerId }),
  });
  return parseJson<{ imageProvider: ImageProviderSettings }>(response);
}

export async function testImageProvider(providerId = "default") {
  const response = await fetch("/api/admin/image-provider/test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ providerId }),
  });
  return parseJson<ImageProviderTestResponse>(response);
}

export async function setAdminUserApiKey(id: string, apiKey: string, providerId?: string) {
  const response = await fetch(`/api/admin/users/${encodeURIComponent(id)}/api-key`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ apiKey, providerId }),
  });
  return parseJson<{ user: UserAccount }>(response);
}

export async function resetAdminUserPassword(id: string, password: string) {
  const response = await fetch(`/api/admin/users/${encodeURIComponent(id)}/password`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ password }),
  });
  return parseJson<{ ok: boolean }>(response);
}

export async function updateAdminPackage(id: string, patch: Partial<RechargePackage>) {
  const response = await fetch(`/api/admin/packages/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(patch),
  });
  return parseJson<{ package: RechargePackage }>(response);
}

export async function adjustAdminCredits(userId: string, amount: number, reason: string) {
  const response = await fetch("/api/admin/credits/adjust", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ userId, amount, reason }),
  });
  return parseJson<{ user: UserAccount; balanceAfter: number }>(response);
}

export async function fetchWorkflowDashboard(): Promise<WorkflowDashboard> {
  const response = await fetch("/api/workflows/dashboard", { credentials: "include" });
  return parseJson<WorkflowDashboard>(response);
}

export async function createWorkflowJob(input: {
  type: WorkflowType;
  title: string;
  prompt: string;
  assets: WorkflowAsset[];
  options: Record<string, unknown>;
}) {
  const response = await fetch("/api/workflows/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(input),
  });
  const data = (await response.json().catch(() => ({}))) as { job?: WorkflowJob; dashboard?: WorkflowDashboard; error?: string };
  if (data.job && data.dashboard) return data as { job: WorkflowJob; dashboard: WorkflowDashboard; error?: string };
  if (!response.ok || data.error) throw new Error(data.error || `请求失败: ${response.status}`);
  return data as { job: WorkflowJob; dashboard: WorkflowDashboard; error?: string };
}

export async function requestGeneration({
  mode,
  settings,
  references,
  prompt,
  userPrompt,
  apiSize,
  ratioLabel,
}: {
  mode: GenerationMode;
  settings: StudioSettings;
  references: ReferenceImage[];
  prompt: string;
  /** 用户原话。拼装后的 prompt 带着一堆行业约束，回看时没人想读那个。 */
  userPrompt?: string;
  apiSize: string;
  ratioLabel: string;
}): Promise<GenerateApiResponse> {
  const form = new FormData();
  const referencePayload = references.map(({ file, previewUrl, ...reference }) => ({
    ...reference,
    hasFile: Boolean(file),
    sourceUrl: file ? undefined : reusableReferenceUrl(previewUrl),
  }));

  form.append(
    "payload",
    JSON.stringify({
      mode: mode.id,
      action: mode.action,
      prompt,
      userPrompt: userPrompt ?? prompt,
      settings,
      references: referencePayload,
      apiSize,
      ratioLabel,
    }),
  );

  for (const reference of references) {
    if (reference.file) {
      form.append("images", reference.file, `${reference.label}-${reference.file.name}`);
    }
  }

  const response = await fetch("/api/generate", {
    method: "POST",
    credentials: "include",
    body: form,
  });
  return parseJson<GenerateApiResponse>(response);
}

/* ── 短视频 ──────────────────────────────────────────────────────────────── */

export interface ShortVideoOverview {
  engine: ShortVideoEngineStatus;
  llm: ShortVideoLlmStatus;
  options: ShortVideoOptions;
  musics: ShortVideoFile[];
  materials: ShortVideoFile[];
  tasks: ShortVideoTask[];
  tasksPagination?: PageInfo;
  /** 整个账号在跑的任务数（不是当前这一页的），并发上限按它判断。 */
  activeCount?: number;
}

export async function fetchShortVideoOverview() {
  const response = await fetch("/api/shortvideo/overview", { credentials: "include" });
  return parseJson<ShortVideoOverview>(response);
}

export async function testShortVideoEngine() {
  const response = await fetch("/api/shortvideo/engine/test", { method: "POST", credentials: "include" });
  return parseJson<{ engine: ShortVideoEngineStatus }>(response);
}

export async function generateShortVideoScript(input: { subject: string; language: string; paragraphs?: number; prompt?: string }) {
  const response = await fetch("/api/shortvideo/script", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(input),
  });
  return parseJson<{ script: string }>(response);
}

export async function generateShortVideoTerms(input: { subject: string; script: string; amount?: number }) {
  const response = await fetch("/api/shortvideo/terms", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(input),
  });
  return parseJson<{ terms: string[] }>(response);
}

export async function fetchShortVideoTasks(query: { page?: number; pageSize?: number } = {}) {
  const response = await fetch(`/api/shortvideo/tasks${pageQuery(query)}`, { credentials: "include" });
  return parseJson<{ tasks: ShortVideoTask[]; pagination?: PageInfo; activeCount?: number }>(response);
}

export async function archiveShortVideoTask(id: string) {
  const response = await fetch(`/api/shortvideo/tasks/${encodeURIComponent(id)}/archive`, { method: "POST", credentials: "include" });
  return parseJson<{ ok: boolean; task: ShortVideoTask }>(response);
}

export async function fetchShortVideoTask(id: string) {
  const response = await fetch(`/api/shortvideo/tasks/${encodeURIComponent(id)}`, { credentials: "include" });
  return parseJson<{ task: ShortVideoTask }>(response);
}

export async function createShortVideoTask(input: ShortVideoRequest) {
  const response = await fetch("/api/shortvideo/tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(input),
  });
  return parseJson<{ task: ShortVideoTask }>(response);
}

export async function deleteShortVideoTask(id: string) {
  const response = await fetch(`/api/shortvideo/tasks/${encodeURIComponent(id)}`, { method: "DELETE", credentials: "include" });
  return parseJson<{ ok: boolean }>(response);
}

export async function uploadShortVideoMaterial(file: File) {
  const form = new FormData();
  form.append("file", file, file.name);
  const response = await fetch("/api/shortvideo/materials", { method: "POST", credentials: "include", body: form });
  return parseJson<{ file: string; originalName: string; size: number }>(response);
}

export async function generateShortVideoMetadata(input: { subject: string; script: string; platform: string; language?: string }) {
  const response = await fetch("/api/shortvideo/metadata", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(input),
  });
  return parseJson<{ metadata: ShortVideoMetadata; platform: string }>(response);
}

export async function uploadShortVideoMusic(file: File) {
  const form = new FormData();
  form.append("file", file, file.name);
  const response = await fetch("/api/shortvideo/musics", { method: "POST", credentials: "include", body: form });
  return parseJson<{ file: string; originalName: string; size: number }>(response);
}

export async function fetchShortVideoMaterials() {
  const response = await fetch("/api/shortvideo/materials", { credentials: "include" });
  return parseJson<{ files: ShortVideoFile[] }>(response);
}

/** 后台：按账号打开 / 关闭短视频。 */
export async function setUserShortVideoAccess(userId: string, enabled: boolean) {
  const response = await fetch(`/api/admin/users/${encodeURIComponent(userId)}/shortvideo`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ enabled }),
  });
  return parseJson<{ shortVideoEnabled: boolean; canUseShortVideo: boolean }>(response);
}

/* 后台：短视频接口配置 */

export async function fetchShortVideoAdmin() {
  const response = await fetch("/api/admin/shortvideo", { credentials: "include" });
  return parseJson<ShortVideoAdminOverview>(response);
}

export async function saveShortVideoSettings(input: {
  llmProviderId?: string;
  llmBaseUrl?: string;
  llmModel?: string;
  llmApiKey?: string;
  maxActivePerUser?: number | string;
}) {
  const response = await fetch("/api/admin/shortvideo/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(input),
  });
  return parseJson<{ settings: ShortVideoAdminSettings }>(response);
}

export async function testShortVideoLlm() {
  const response = await fetch("/api/admin/shortvideo/llm/test", { method: "POST", credentials: "include" });
  return parseJson<{ result: { ok: boolean; message: string; model: string } }>(response);
}

export async function saveShortVideoEngineConfig(patch: Record<string, string | number>) {
  const response = await fetch("/api/admin/shortvideo/engine-config", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(patch),
  });
  return parseJson<{ changed: string[]; needsRestart: boolean; restartAvailable: boolean; engineConfig: ShortVideoEngineConfig }>(response);
}

export async function restartShortVideoEngine(force = false) {
  const response = await fetch("/api/admin/shortvideo/engine/restart", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ force }),
  });
  return parseJson<{ engine: ShortVideoAdminOverview["engine"] }>(response);
}

/* ── Seedance（火山方舟视频生成） ─────────────────────────────────────────── */

export interface SeedanceOverview {
  status: SeedanceStatusInfo;
  options: SeedanceOptions;
  refs: SeedanceRef[];
  tasks: SeedanceTask[];
  pagination: PageInfo;
  activeCount: number;
  /** 真在方舟那边排队 / 生成的条数（占并发的只有这些；本站排队的不算）。 */
  arkActiveCount?: number;
}

export async function fetchSeedanceOverview(params: { page?: number } = {}) {
  const query = new URLSearchParams();
  if (params.page) query.set("page", String(params.page));
  const suffix = query.toString() ? `?${query}` : "";
  const response = await fetch(`/api/seedance/overview${suffix}`, { credentials: "include" });
  return parseJson<SeedanceOverview>(response);
}

export async function testSeedance() {
  const response = await fetch("/api/seedance/test", { method: "POST", credentials: "include" });
  return parseJson<{ status: SeedanceStatusInfo }>(response);
}

export async function fetchSeedanceTasks(params: { page?: number; pageSize?: number } = {}) {
  const query = new URLSearchParams();
  if (params.page) query.set("page", String(params.page));
  if (params.pageSize) query.set("pageSize", String(params.pageSize));
  const suffix = query.toString() ? `?${query}` : "";
  const response = await fetch(`/api/seedance/tasks${suffix}`, { credentials: "include" });
  return parseJson<{ tasks: SeedanceTask[]; pagination: PageInfo; activeCount: number; arkActiveCount?: number }>(response);
}

export async function createSeedanceTasks(input: Partial<SeedanceRequest>) {
  const response = await fetch("/api/seedance/tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(input),
  });
  return parseJson<{ tasks: SeedanceTask[]; group?: SeedanceGroup | null; warning: string | null; activeCount: number; arkActiveCount?: number }>(response);
}

export async function deleteSeedanceTask(taskId: string, { force = false } = {}) {
  const response = await fetch(`/api/seedance/tasks/${encodeURIComponent(taskId)}${force ? "?force" : ""}`, { method: "DELETE", credentials: "include" });
  return parseJson<{ ok: boolean; activeCount: number; arkActiveCount?: number }>(response);
}

/** 手动把成片推到账号的 WebDAV（和生成图的「归档」一样）。 */
export async function archiveSeedanceTask(taskId: string) {
  const response = await fetch(`/api/seedance/tasks/${encodeURIComponent(taskId)}/archive`, { method: "POST", credentials: "include" });
  return parseJson<{ ok: boolean; task: SeedanceTask }>(response);
}

export async function fetchSeedanceGroup(groupId: string) {
  const response = await fetch(`/api/seedance/groups/${encodeURIComponent(groupId)}`, { credentials: "include" });
  return parseJson<{ group: SeedanceGroup; tasks: SeedanceTask[] }>(response);
}

/** 合并失败后再试一次。 */
export async function retrySeedanceGroupMerge(groupId: string) {
  const response = await fetch(`/api/seedance/groups/${encodeURIComponent(groupId)}/merge`, { method: "POST", credentials: "include" });
  return parseJson<{ group: SeedanceGroup }>(response);
}

export async function createSeedanceLastFrameRef(taskId: string) {
  const response = await fetch(`/api/seedance/tasks/${encodeURIComponent(taskId)}/last-frame-ref`, { method: "POST", credentials: "include" });
  return parseJson<{ ref: SeedanceRef }>(response);
}

export async function fetchSeedanceRefs() {
  const response = await fetch("/api/seedance/refs", { credentials: "include" });
  return parseJson<{ refs: SeedanceRef[] }>(response);
}

export async function uploadSeedanceRef(file: File) {
  const form = new FormData();
  form.append("file", file, file.name);
  const response = await fetch("/api/seedance/refs", { method: "POST", credentials: "include", body: form });
  return parseJson<{ ref: SeedanceRef }>(response);
}

export async function deleteSeedanceRef(refId: string) {
  const response = await fetch(`/api/seedance/refs/${encodeURIComponent(refId)}`, { method: "DELETE", credentials: "include" });
  return parseJson<{ ok: boolean }>(response);
}

export async function fetchSeedanceAdmin() {
  const response = await fetch("/api/admin/seedance", { credentials: "include" });
  return parseJson<SeedanceAdminOverview>(response);
}

export async function saveSeedanceSettings(input: {
  apiKey?: string;
  baseUrl?: string;
  defaultModel?: string;
  maxActivePerUser?: number | string;
  publicBaseUrl?: string;
  enabledModels?: string[] | "";
}) {
  const response = await fetch("/api/admin/seedance/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(input),
  });
  return parseJson<{ settings: SeedanceAdminSettings; status: SeedanceStatusInfo }>(response);
}

export async function testSeedanceAdmin() {
  const response = await fetch("/api/admin/seedance/test", { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include", body: JSON.stringify({ probeModels: true }) });
  return parseJson<{ ok: boolean; latencyMs: number; total: number; models: SeedanceArkModel[]; modelsError?: string; modelAccess: SeedanceModelAccess[]; status: SeedanceStatusInfo }>(response);
}

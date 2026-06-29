import type {
  CreditLedgerEntry,
  GeneratedResult,
  GenerationMode,
  PaymentCapabilities,
  PaymentConfigStatus,
  PaymentOrder,
  PaymentProvider,
  RechargePackage,
  ReferenceImage,
  StudioSettings,
  UserAccount,
  WorkflowAsset,
  WorkflowDashboard,
  WorkflowJob,
  WorkflowType,
} from "../types";

export interface ApiConfig {
  mode: "demo" | "live";
  providerReady: boolean;
  imageModelConfigured: boolean;
  providerHealth?: import("../types").ImageProviderHealth;
  authEnabled: boolean;
  port: number;
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
  paymentCapabilities: PaymentCapabilities;
  paymentConfig: PaymentConfigStatus;
}

export interface AdminOverviewResponse {
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
  paymentCapabilities: PaymentCapabilities;
  paymentConfig: PaymentConfigStatus;
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

export async function deleteGenerationResult(id: string) {
  const response = await fetch(`/api/generation-results/${encodeURIComponent(id)}`, {
    method: "DELETE",
    credentials: "include",
  });
  return parseJson<{ deleted: boolean; id: string; file?: { deleted?: boolean; fileName?: string; reason?: string } | null }>(response);
}

export async function updateGenerationResultStorageStatus(id: string, storageStatus: GeneratedResult["storageStatus"]) {
  const response = await fetch(`/api/generation-results/${encodeURIComponent(id)}/storage-status`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ storageStatus }),
  });
  return parseJson<{ result: GeneratedResult }>(response);
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
  apiSize,
  ratioLabel,
}: {
  mode: GenerationMode;
  settings: StudioSettings;
  references: ReferenceImage[];
  prompt: string;
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

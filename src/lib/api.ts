import type { GenerationMode, ReferenceImage, StudioSettings } from "../types";

export interface ApiConfig {
  mode: "demo" | "live";
  providerReady: boolean;
  imageModelConfigured: boolean;
  port: number;
}

export interface GenerateApiResult {
  imageUrl: string;
  revisedPrompt?: string;
  index: number;
}

export interface GenerateApiResponse extends ApiConfig {
  results: GenerateApiResult[];
  message: string;
  error?: string;
}

export async function fetchApiConfig(): Promise<ApiConfig> {
  const response = await fetch("/api/config");
  if (!response.ok) {
    throw new Error(`配置读取失败: ${response.status}`);
  }
  return response.json();
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
  const referencePayload = references.map(({ file, previewUrl: _previewUrl, ...reference }) => ({
    ...reference,
    hasFile: Boolean(file),
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
    body: form,
  });
  const data = (await response.json()) as GenerateApiResponse;
  if (!response.ok || data.error) {
    throw new Error(data.error || `生成失败: ${response.status}`);
  }
  return data;
}

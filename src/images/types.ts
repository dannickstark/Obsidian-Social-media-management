/** Sizes accepted by the GPT Image API. The original PNG is kept in the vault. */
export type ImageGenerationSize = "1024x1024" | "1024x1536" | "1536x1024";

export interface ImageGenerationRequest {
  prompt: string;
  negativePrompt?: string;
  size: ImageGenerationSize;
  signal?: AbortSignal;
}

export type FocalPoint = [number, number];

/** Vault paths, never public URLs. The crop is the media entry sent to a platform. */
export interface GeneratedMediaProvenance {
  sourcePath: string;
  cropPath?: string;
  cropRatio?: number;
  focus: FocalPoint;
}

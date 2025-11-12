/**
 * Vision-language model type definitions for Phase 4 Multimodal Support
 */

import type { ModelDescriptor, ModelHandle } from './models.js';
import type { GeneratorParams } from './generators.js';

/**
 * Vision-specific model descriptor
 * Extends base ModelDescriptor for vision-language models
 */
export interface VisionModelDescriptor extends ModelDescriptor {
  /** Vision-language models have multimodal modality */
  modality: 'vision' | 'multimodal';
  /** Vision models use mlx-vlm family */
  family: 'mlx-vlm';
  /** Image encoder architecture */
  imageEncoder: 'clip' | 'vit' | 'siglip';
  /** Maximum supported image size (pixels) */
  maxImageSize: number;
  /** Image preprocessing configuration */
  imagePreprocessing?: {
    /** Target resolution for image resizing */
    resolution: number;
    /** Patch size for vision transformer */
    patchSize: number;
    /** Normalization mean values */
    mean: [number, number, number];
    /** Normalization std values */
    std: [number, number, number];
  };
}

/**
 * Vision model handle
 * Extends base ModelHandle with vision-specific metadata
 */
export interface VisionModelHandle extends ModelHandle {
  descriptor: VisionModelDescriptor;
  /** Vision-specific runtime metadata */
  metadata: {
    /** Supported image formats */
    supportedFormats: string[];
    /** Maximum batch size for images */
    maxBatchSize: number;
    /** Additional model-specific metadata */
    [key: string]: unknown;
  };
}

/**
 * Image input specification
 * Supports multiple input formats: file path, URL, Buffer, or base64
 */
export interface ImageInput {
  /**
   * Image source
   * - string: file path, URL, or base64-encoded data (with data:image/... prefix)
   * - Buffer: raw image bytes
   */
  source: string | Buffer;
  /**
   * Image format hint
   * Auto-detected if not specified
   */
  format?: 'png' | 'jpg' | 'jpeg' | 'webp' | 'bmp';
  /**
   * Optional image metadata
   */
  metadata?: {
    width?: number;
    height?: number;
    channels?: number;
  };
}

/**
 * Vision-specific generation parameters
 * Extends base GeneratorParams with image input
 */
export interface VisionGeneratorParams extends Omit<GeneratorParams, 'multimodal'> {
  /**
   * Single image input or array of images for multi-image prompts
   */
  image: ImageInput | ImageInput[];
  /**
   * Vision-specific configuration
   */
  visionConfig?: {
    /** Override image resolution (default: model's maxImageSize) */
    imageResolution?: number;
    /** Override patch size (default: model's preprocessing config) */
    patchSize?: number;
    /** Enable image tiling for high-resolution images */
    enableTiling?: boolean;
    /** Number of tiles (if tiling enabled) */
    numTiles?: number;
  };
}

/**
 * Options for loading vision-language models
 */
export interface LoadVisionModelOptions {
  /**
   * Model identifier (HuggingFace ID or local path)
   * Examples: 'llava-hf/llava-1.5-7b-hf', 'Qwen/Qwen-VL-Chat'
   */
  model: string;
  /**
   * Model revision/branch (default: 'main')
   */
  revision?: string;
  /**
   * Quantization configuration
   */
  quantization?: {
    /** Quantization bits (4 or 8) */
    bits: 4 | 8;
    /** Group size for quantization */
    groupSize?: number;
  };
  /**
   * Image preprocessing overrides
   */
  preprocessing?: Partial<VisionModelDescriptor['imagePreprocessing']>;
  /**
   * Model-specific configuration
   */
  config?: Record<string, unknown>;
}

/**
 * Image encoding result
 * Internal type for image → embeddings conversion
 */
export interface ImageEmbedding {
  /** Image embeddings (vision features) */
  embeddings: number[][];
  /** Original image dimensions */
  originalSize: {
    width: number;
    height: number;
  };
  /** Processed image dimensions */
  processedSize: {
    width: number;
    height: number;
  };
  /** Number of patches/tokens */
  numTokens: number;
}

/**
 * Vision generation chunk
 * Extends base GeneratorChunk with vision-specific metadata
 */
export interface VisionGeneratorChunk {
  type: 'token' | 'metadata' | 'error' | 'image_processed';
  /** Token content (if type === 'token') */
  token?: string;
  /** Log probability (if type === 'token') */
  logprob?: number;
  /** Generation statistics (if type === 'metadata') */
  stats?: {
    tokensGenerated: number;
    tokensPerSecond: number;
    timeToFirstToken: number;
    totalTime: number;
    /** Image processing time (ms) */
    imageProcessingTime?: number;
    /** Image encoding time (ms) */
    imageEncodingTime?: number;
  };
  /** Error details (if type === 'error') */
  error?: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
  /** Image processing metadata (if type === 'image_processed') */
  imageMetadata?: {
    numImages: number;
    totalTokens: number;
    resolutions: Array<{ width: number; height: number }>;
  };
}

/**
 * Supported vision-language model families
 */
export type VisionModelFamily =
  | 'llava'      // LLaVA (Large Language and Vision Assistant)
  | 'qwen-vl'    // Qwen-VL (Alibaba Cloud)
  | 'phi-vision' // Phi-3-Vision (Microsoft)
  | 'fuyu'       // Fuyu (Adept)
  | 'cogvlm';    // CogVLM (Zhipu AI)

/**
 * Model-specific capabilities
 */
export interface VisionModelCapabilities {
  /** Supports multiple images in single prompt */
  multiImage: boolean;
  /** Supports image + text interleaved prompts */
  interleavedPrompts: boolean;
  /** Supports video frames */
  videoFrames: boolean;
  /** Supports OCR (text extraction) */
  ocr: boolean;
  /** Supports grounding (bounding boxes) */
  grounding: boolean;
  /** Maximum number of images per prompt */
  maxImages: number;
}

/**
 * Image encoding utilities for Phase 4 Multimodal Support
 * Handles conversion between file paths, URLs, Buffers, and base64
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ImageInput } from '../types/vision.js';

/**
 * Error codes for image encoding operations
 */
export const IMAGE_ENCODING_ERRORS = {
  INVALID_INPUT: 'INVALID_IMAGE_INPUT',
  FILE_NOT_FOUND: 'IMAGE_FILE_NOT_FOUND',
  UNSUPPORTED_FORMAT: 'UNSUPPORTED_IMAGE_FORMAT',
  ENCODING_FAILED: 'IMAGE_ENCODING_FAILED',
  FETCH_FAILED: 'IMAGE_FETCH_FAILED',
  UNSAFE_PATH: 'UNSAFE_IMAGE_PATH',
} as const;

/**
 * Supported image formats
 */
export const SUPPORTED_IMAGE_FORMATS = [
  'png',
  'jpg',
  'jpeg',
  'webp',
  'bmp',
  'gif',
] as const;

/**
 * Image encoding error
 */
export class ImageEncodingError extends Error {
  constructor(
    public code: string,
    message: string,
    public details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ImageEncodingError';
  }
}

/**
 * Encode image to base64
 * Handles multiple input formats: file path, URL, Buffer, base64
 *
 * @param imageInput - Image input specification
 * @returns Base64-encoded image data with data URI prefix
 *
 * @example
 * ```typescript
 * // From file path
 * const base64 = await encodeImageToBase64({ source: './image.png' });
 *
 * // From URL
 * const base64 = await encodeImageToBase64({ source: 'https://example.com/image.jpg' });
 *
 * // From Buffer
 * const buffer = await readFile('./image.png');
 * const base64 = await encodeImageToBase64({ source: buffer, format: 'png' });
 * ```
 */
export async function encodeImageToBase64(imageInput: ImageInput): Promise<string> {
  const { source, format } = imageInput;

  try {
    // Case 1: Already base64 with data URI
    if (typeof source === 'string' && source.startsWith('data:image/')) {
      return source;
    }

    // Case 2: Buffer
    if (Buffer.isBuffer(source)) {
      const detectedFormat = format || 'png';
      validateImageFormat(detectedFormat);
      const base64 = source.toString('base64');
      return `data:image/${detectedFormat};base64,${base64}`;
    }

    // Case 3: URL (http/https)
    if (typeof source === 'string' && (source.startsWith('http://') || source.startsWith('https://'))) {
      return await encodeImageFromURL(source, format);
    }

    // Case 4: Plain base64 string (no data URI) - Check BEFORE file path!
    // Bug fix: Moved before file path check so base64 strings aren't treated as paths
    if (typeof source === 'string' && isBase64(source)) {
      const detectedFormat = format || 'png';
      validateImageFormat(detectedFormat);
      return `data:image/${detectedFormat};base64,${source}`;
    }

    // Case 5: File path (fallback for remaining strings)
    if (typeof source === 'string') {
      return await encodeImageFromFile(source, format);
    }

    throw new ImageEncodingError(
      IMAGE_ENCODING_ERRORS.INVALID_INPUT,
      'Invalid image input: source must be a file path, URL, Buffer, or base64 string',
      { source: typeof source, format },
    );
  } catch (error) {
    if (error instanceof ImageEncodingError) {
      throw error;
    }
    throw new ImageEncodingError(
      IMAGE_ENCODING_ERRORS.ENCODING_FAILED,
      `Failed to encode image: ${error instanceof Error ? error.message : String(error)}`,
      { source: typeof source, format },
    );
  }
}

/**
 * Encode image from file path
 * Security: Validates path to prevent traversal attacks and unauthorized file access
 */
async function encodeImageFromFile(filePath: string, format?: string): Promise<string> {
  // Security fix: Validate path before resolving to prevent path traversal
  validateImagePath(filePath);

  const resolvedPath = resolve(filePath);

  if (!existsSync(resolvedPath)) {
    throw new ImageEncodingError(
      IMAGE_ENCODING_ERRORS.FILE_NOT_FOUND,
      `Image file not found: ${filePath}`,
      { filePath: resolvedPath },
    );
  }

  // Detect format from file extension if not provided
  const detectedFormat = format || detectFormatFromPath(filePath);
  validateImageFormat(detectedFormat);

  const buffer = await readFile(resolvedPath);
  const base64 = buffer.toString('base64');

  return `data:image/${detectedFormat};base64,${base64}`;
}

/**
 * Encode image from URL
 */
async function encodeImageFromURL(url: string, format?: string): Promise<string> {
  try {
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Detect format from Content-Type header or URL
    const detectedFormat =
      format ||
      detectFormatFromContentType(response.headers.get('content-type')) ||
      detectFormatFromPath(url);

    validateImageFormat(detectedFormat);

    const base64 = buffer.toString('base64');
    return `data:image/${detectedFormat};base64,${base64}`;
  } catch (error) {
    throw new ImageEncodingError(
      IMAGE_ENCODING_ERRORS.FETCH_FAILED,
      `Failed to fetch image from URL: ${error instanceof Error ? error.message : String(error)}`,
      { url },
    );
  }
}

/**
 * Detect image format from file path extension
 */
function detectFormatFromPath(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase();
  if (!ext || !SUPPORTED_IMAGE_FORMATS.includes(ext as typeof SUPPORTED_IMAGE_FORMATS[number])) {
    return 'png'; // Default fallback
  }
  // Normalize jpeg → jpg
  return ext === 'jpeg' ? 'jpg' : ext;
}

/**
 * Detect image format from Content-Type header
 */
function detectFormatFromContentType(contentType: string | null): string | null {
  if (!contentType) return null;

  const match = contentType.match(/image\/(png|jpe?g|webp|bmp|gif)/i);
  if (!match) return null;

  const format = match[1].toLowerCase();
  return format === 'jpeg' ? 'jpg' : format;
}

/**
 * Validate image format
 */
function validateImageFormat(format: string): asserts format is typeof SUPPORTED_IMAGE_FORMATS[number] {
  if (!SUPPORTED_IMAGE_FORMATS.includes(format as typeof SUPPORTED_IMAGE_FORMATS[number])) {
    throw new ImageEncodingError(
      IMAGE_ENCODING_ERRORS.UNSUPPORTED_FORMAT,
      `Unsupported image format: ${format}`,
      { format, supported: SUPPORTED_IMAGE_FORMATS },
    );
  }
}

/**
 * Validate image path for security
 * Security fix: Prevent path traversal attacks and unauthorized file access
 */
function validateImagePath(filePath: string): void {
  // Resolve to absolute path for checking
  const absolutePath = resolve(filePath);

  // Block access to sensitive system directories
  const dangerousPatterns = [
    '/etc/',
    '/root/',
    '/usr/bin/',
    '/usr/sbin/',
    '/bin/',
    '/sbin/',
    '/var/log/',
    '/var/run/',
    '/sys/',
    '/proc/',
    '/.ssh/',
  ];

  for (const pattern of dangerousPatterns) {
    if (absolutePath.startsWith(pattern)) {
      throw new ImageEncodingError(
        IMAGE_ENCODING_ERRORS.UNSAFE_PATH,
        `Access to system directories is not allowed: ${pattern}`,
        { filePath, resolvedPath: absolutePath },
      );
    }
  }

  // Reject paths with traversal sequences (but allow if they resolve within safe areas)
  const normalizedPath = filePath.replace(/\\/g, '/');
  if (normalizedPath.includes('../') || normalizedPath.includes('/..')) {
    // Additional check: even with .., does it try to escape to dangerous areas?
    for (const pattern of dangerousPatterns) {
      if (absolutePath.startsWith(pattern)) {
        throw new ImageEncodingError(
          IMAGE_ENCODING_ERRORS.UNSAFE_PATH,
          'Path traversal to system directories is not allowed',
          { filePath, resolvedPath: absolutePath },
        );
      }
    }
  }
}

/**
 * Check if string is valid base64
 */
function isBase64(str: string): boolean {
  if (str.length === 0) return false;
  // Base64 pattern: alphanumeric + + / = (padding)
  const base64Regex = /^[A-Za-z0-9+/]+={0,2}$/;
  return base64Regex.test(str) && str.length % 4 === 0;
}

/**
 * Extract base64 data from data URI
 * Removes the 'data:image/...;base64,' prefix
 */
export function extractBase64FromDataURI(dataURI: string): string {
  if (!dataURI.startsWith('data:image/')) {
    throw new ImageEncodingError(
      IMAGE_ENCODING_ERRORS.INVALID_INPUT,
      'Invalid data URI: must start with "data:image/"',
      { dataURI: dataURI.substring(0, 50) },
    );
  }

  const base64Index = dataURI.indexOf('base64,');
  if (base64Index === -1) {
    throw new ImageEncodingError(
      IMAGE_ENCODING_ERRORS.INVALID_INPUT,
      'Invalid data URI: missing base64 encoding',
      { dataURI: dataURI.substring(0, 50) },
    );
  }

  return dataURI.substring(base64Index + 7); // Skip 'base64,'
}

/**
 * Get image format from data URI
 */
export function getFormatFromDataURI(dataURI: string): string {
  if (!dataURI.startsWith('data:image/')) {
    throw new ImageEncodingError(
      IMAGE_ENCODING_ERRORS.INVALID_INPUT,
      'Invalid data URI: must start with "data:image/"',
      { dataURI: dataURI.substring(0, 50) },
    );
  }

  const match = dataURI.match(/^data:image\/([a-z]+);/);
  if (!match) {
    throw new ImageEncodingError(
      IMAGE_ENCODING_ERRORS.INVALID_INPUT,
      'Invalid data URI: cannot extract format',
      { dataURI: dataURI.substring(0, 50) },
    );
  }

  return match[1];
}

/**
 * Batch encode multiple images
 *
 * @param images - Array of image inputs
 * @returns Array of base64-encoded images
 *
 * @example
 * ```typescript
 * const images = [
 *   { source: './image1.png' },
 *   { source: 'https://example.com/image2.jpg' },
 *   { source: buffer, format: 'webp' },
 * ];
 * const encoded = await batchEncodeImages(images);
 * ```
 */
export async function batchEncodeImages(images: ImageInput[]): Promise<string[]> {
  return Promise.all(images.map((img) => encodeImageToBase64(img)));
}

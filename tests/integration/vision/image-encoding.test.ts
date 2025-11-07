import { describe, it, expect } from 'vitest';
import {
  encodeImageToBase64,
  batchEncodeImages,
  extractBase64FromDataURI,
  getFormatFromDataURI,
  ImageEncodingError,
} from '../../../src/utils/image-encoding.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('Image Encoding', () => {
  const testImagePath = join(__dirname, '../../fixtures/test-image.jpg');

  it('should encode from file path', async () => {
    const base64 = await encodeImageToBase64({ source: testImagePath });

    expect(base64).toMatch(/^data:image\/jpe?g;base64,/);
    // Fix: Test image is 288 bytes, base64 encoded + data URI = ~400 bytes
    expect(base64.length).toBeGreaterThan(300);
    expect(base64).toContain('base64,');
  });

  it('should encode from Buffer', async () => {
    const buffer = readFileSync(testImagePath);
    const base64 = await encodeImageToBase64({
      source: buffer,
      format: 'jpg',
    });

    expect(base64).toMatch(/^data:image\/jpg;base64,/);
  });

  it('should handle batch encoding', async () => {
    const images = [
      { source: testImagePath },
      { source: readFileSync(testImagePath), format: 'jpg' as const },
    ];

    const encoded = await batchEncodeImages(images);

    expect(encoded).toHaveLength(2);
    expect(encoded[0]).toMatch(/^data:image/);
    expect(encoded[1]).toMatch(/^data:image/);
  });

  it('should extract base64 from data URI', () => {
    const dataURI = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';
    const base64 = extractBase64FromDataURI(dataURI);

    expect(base64).toBe('iVBORw0KGgoAAAANSUhEUg==');
  });

  it('should get format from data URI', () => {
    const format = getFormatFromDataURI('data:image/webp;base64,abc123');

    expect(format).toBe('webp');
  });

  it('should throw on invalid file path', async () => {
    await expect(
      encodeImageToBase64({ source: '/nonexistent/image.jpg' })
    ).rejects.toThrow(ImageEncodingError);
  });

  it('should throw on unsupported format', async () => {
    await expect(
      encodeImageToBase64({
        source: readFileSync(testImagePath),
        format: 'invalid' as unknown as 'jpg',
      })
    ).rejects.toThrow(ImageEncodingError);
  });
});

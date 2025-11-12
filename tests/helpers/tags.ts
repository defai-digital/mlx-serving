/**
 * Shared tagging utilities for critical integration suites.
 *
 * `ENGINE_TOP20_TAG` acts as a stable label that can be grepped or
 * filtered from reporter output, ensuring we always know which tests
 * provide coverage for the Engine facade contract.
 */
export const ENGINE_TOP20_TAG = '[engine-top20]';

/**
 * Prefix a test/describe title with the engine top-20 tag.
 */
export const tagEngineTop20 = (name: string): string => `${ENGINE_TOP20_TAG} ${name}`;

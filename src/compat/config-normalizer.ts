import type {
  LoadModelOptions,
  GeneratorParams,
  TokenizeRequest,
} from '../types/index.js';

type UnknownRecord = Record<string, unknown>;

const GENERATOR_PARAM_MAPPINGS = [
  ['maxTokens', 'max_tokens'],
  ['temperature', 'temperature'],
  ['topP', 'top_p'],
  ['presencePenalty', 'presence_penalty'],
  ['frequencyPenalty', 'frequency_penalty'],
  ['repetitionPenalty', 'repetition_penalty'],
  ['stopSequences', 'stop_sequences'],
  ['stopTokenIds', 'stop_token_ids'],
  ['seed', 'seed'],
  ['streaming', 'streaming'],
  ['draftModel', 'draft_model'], // Phase 1.2: Draft model for speculative decoding
  ['promptTokens', 'prompt_tokens'], // P2-2: Pre-tokenized prompt support
] as const;

const LOAD_MODEL_OPTION_MAPPINGS = [
  ['revision', 'revision'],
  ['quantization', 'quantization'],
  ['draft', 'draft'],
  ['localPath', 'local_path'],
] as const;

const TOKENIZE_REQUEST_MAPPINGS = [
  ['addBos', 'add_bos'],
] as const;

// P2-2: Exclude index signature from keyof to fix type compatibility
const GENERATOR_ALIAS_KEYS: Record<string, Exclude<keyof GeneratorParams, number>> = {
  stream: 'streaming',
  model_id: 'model',
};

const LOAD_MODEL_ALIAS_KEYS: Record<string, Exclude<keyof LoadModelOptions, number>> = {
  model_id: 'model',
};

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null;
}

function preferDefined<T>(primary: T | undefined, secondary: T | undefined): T | undefined {
  return primary === undefined ? secondary : primary;
}

function applyCamelMappings(
  target: UnknownRecord,
  source: UnknownRecord,
  mappings: ReadonlyArray<readonly [string, string]>
): void {
  for (const [camelKey, snakeKey] of mappings) {
    const camelValue = source[camelKey];
    const snakeValue = source[snakeKey];
    const value = preferDefined(camelValue, snakeValue);
    if (value !== undefined) {
      target[camelKey] = value;
    }
  }
}

function applySnakeMappings(
  target: UnknownRecord,
  source: UnknownRecord,
  mappings: ReadonlyArray<readonly [string, string]>
): void {
  for (const [camelKey, snakeKey] of mappings) {
    const camelValue = source[camelKey];
    const snakeValue = source[snakeKey];
    const value = preferDefined(camelValue, snakeValue);
    if (value !== undefined) {
      target[snakeKey] = value;
    }
  }
}

function applyAliasMappings(
  target: UnknownRecord,
  source: UnknownRecord,
  aliases: Record<string, string>
): void {
  for (const [alias, canonical] of Object.entries(aliases)) {
    const aliasValue = source[alias];
    if (aliasValue !== undefined) {
      target[canonical] = aliasValue;
    }
  }
}

function copyUnknownKeys(
  target: UnknownRecord,
  source: UnknownRecord,
  knownKeys: Set<string>
): void {
  for (const [key, value] of Object.entries(source)) {
    if (!knownKeys.has(key)) {
      target[key] = value;
    }
  }
}

export type SnakeCaseGeneratorParams = Partial<GeneratorParams> &
  UnknownRecord & {
    model_id?: string;
    max_tokens?: number;
    top_p?: number;
    presence_penalty?: number;
    frequency_penalty?: number;
    repetition_penalty?: number;
    stop_sequences?: string[];
    stop_token_ids?: number[];
    seed?: number;
    stream?: boolean;
  };

export function normalizeGeneratorParams(
  params: GeneratorParams | SnakeCaseGeneratorParams | null | undefined
): (Partial<GeneratorParams> & UnknownRecord) | undefined {
  if (!isRecord(params)) {
    return undefined;
  }

  const normalized: UnknownRecord = {};
  const knownKeys = new Set<string>();

  applyCamelMappings(normalized, params, GENERATOR_PARAM_MAPPINGS);
  applyAliasMappings(normalized, params, GENERATOR_ALIAS_KEYS);

  if (params.model !== undefined) {
    normalized.model = params.model;
    knownKeys.add('model');
  }
  if (params.prompt !== undefined) {
    normalized.prompt = params.prompt;
    knownKeys.add('prompt');
  }
  if (params.structured !== undefined) {
    normalized.structured = params.structured;
    knownKeys.add('structured');
  }
  if (params.multimodal !== undefined) {
    normalized.multimodal = params.multimodal;
    knownKeys.add('multimodal');
  }
  if (params.streaming !== undefined) {
    normalized.streaming = params.streaming;
    knownKeys.add('streaming');
  }

  for (const [camelKey] of GENERATOR_PARAM_MAPPINGS) {
    knownKeys.add(camelKey);
  }
  for (const alias of Object.keys(GENERATOR_ALIAS_KEYS)) {
    knownKeys.add(alias);
  }
  for (const snakeKey of GENERATOR_PARAM_MAPPINGS.map(([, snake]) => snake)) {
    knownKeys.add(snakeKey);
  }

  copyUnknownKeys(normalized, params, knownKeys);

  return normalized as Partial<GeneratorParams> & UnknownRecord;
}

export function denormalizeGeneratorParams(
  params: GeneratorParams | SnakeCaseGeneratorParams | null | undefined
): SnakeCaseGeneratorParams | undefined {
  if (!isRecord(params)) {
    return undefined;
  }

  const denormalized: UnknownRecord = {};
  const knownKeys = new Set<string>();

  applySnakeMappings(denormalized, params, GENERATOR_PARAM_MAPPINGS);
  for (const [, snakeKey] of GENERATOR_PARAM_MAPPINGS) {
    knownKeys.add(snakeKey);
  }

  if (params.model !== undefined) {
    denormalized.model = params.model;
    denormalized.model_id = params.model;
    knownKeys.add('model');
    knownKeys.add('model_id');
  }
  if (params.prompt !== undefined) {
    denormalized.prompt = params.prompt;
    knownKeys.add('prompt');
  }
  if (params.structured !== undefined) {
    denormalized.structured = params.structured;
    knownKeys.add('structured');
  }
  if (params.multimodal !== undefined) {
    denormalized.multimodal = params.multimodal;
    knownKeys.add('multimodal');
  }
  if (params.streaming !== undefined) {
    denormalized.streaming = params.streaming;
    knownKeys.add('streaming');
  }

  for (const [, snakeKey] of GENERATOR_PARAM_MAPPINGS) {
    knownKeys.add(snakeKey);
  }

  copyUnknownKeys(denormalized, params, knownKeys);

  return denormalized as SnakeCaseGeneratorParams;
}

export type SnakeCaseLoadModelOptions = LoadModelOptions &
  UnknownRecord & {
    max_tokens?: number;
    top_p?: number;
    presence_penalty?: number;
    frequency_penalty?: number;
    repetition_penalty?: number;
    stop_sequences?: string[];
    stop_token_ids?: number[];
  };

export function normalizeLoadModelOptions(
  options: LoadModelOptions | SnakeCaseLoadModelOptions | string | null | undefined
): (LoadModelOptions & UnknownRecord) | undefined {
  // Support positional string parameter (mlx-engine style)
  if (typeof options === 'string') {
    return { model: options } as LoadModelOptions & UnknownRecord;
  }

  if (!isRecord(options)) {
    return undefined;
  }

  const normalized: UnknownRecord = {};
  const knownKeys = new Set<string>();

  normalized.model = options.model;
  knownKeys.add('model');
  applyAliasMappings(normalized, options, LOAD_MODEL_ALIAS_KEYS);
  for (const alias of Object.keys(LOAD_MODEL_ALIAS_KEYS)) {
    knownKeys.add(alias);
  }

  applyCamelMappings(normalized, options, LOAD_MODEL_OPTION_MAPPINGS);
  for (const [camelKey] of LOAD_MODEL_OPTION_MAPPINGS) {
    knownKeys.add(camelKey);
  }
  for (const [, snakeKey] of LOAD_MODEL_OPTION_MAPPINGS) {
    knownKeys.add(snakeKey);
  }

  const nestedParamsSource =
    'parameters' in options && isRecord(options.parameters)
      ? (options.parameters as SnakeCaseGeneratorParams)
      : 'params' in options && isRecord((options as UnknownRecord).params)
      ? ((options as UnknownRecord).params as SnakeCaseGeneratorParams)
      : null;
  const nestedParams = normalizeGeneratorParams(nestedParamsSource);

  const inlineParams = normalizeGeneratorParams(options as unknown as GeneratorParams);
  const validInlineKeys = new Set<string>([
    ...GENERATOR_PARAM_MAPPINGS.map(([camel]) => camel),
    'structured',
    'multimodal',
    'streaming',
  ]);
  const mergedParameters: UnknownRecord = {
    ...(nestedParams ?? {}),
  };

  if (inlineParams) {
    for (const [key, value] of Object.entries(inlineParams)) {
      if (key === 'model' || key === 'prompt') {
        continue;
      }
      if (!validInlineKeys.has(key)) {
        continue;
      }
      mergedParameters[key] = value;
    }
  }

  if (Object.keys(mergedParameters).length > 0) {
    normalized.parameters = mergedParameters;
    knownKeys.add('parameters');
    knownKeys.add('params');
  }

  copyUnknownKeys(normalized, options, knownKeys);

  return normalized as LoadModelOptions & UnknownRecord;
}

export function denormalizeLoadModelOptions(
  options: LoadModelOptions | SnakeCaseLoadModelOptions | null | undefined
): SnakeCaseLoadModelOptions | undefined {
  if (!isRecord(options)) {
    return undefined;
  }

  const denormalized: UnknownRecord = {};
  const knownKeys = new Set<string>();

  denormalized.model = options.model;
  denormalized.model_id = options.model;
  knownKeys.add('model');
  knownKeys.add('model_id');

  applySnakeMappings(denormalized, options, LOAD_MODEL_OPTION_MAPPINGS);
  for (const [, snakeKey] of LOAD_MODEL_OPTION_MAPPINGS) {
    knownKeys.add(snakeKey);
  }

  const parameters =
    options.parameters ??
    (isRecord((options as UnknownRecord).parameters)
      ? ((options as UnknownRecord).parameters as UnknownRecord)
      : undefined);

  if (parameters) {
    const denormalizedParams = denormalizeGeneratorParams(parameters);
    if (denormalizedParams) {
      denormalized.parameters = denormalizedParams;
    }
    knownKeys.add('parameters');
  }

  copyUnknownKeys(denormalized, options, knownKeys);

  return denormalized as SnakeCaseLoadModelOptions;
}

export type SnakeCaseTokenizeRequest = TokenizeRequest &
  UnknownRecord & {
    add_bos?: boolean;
    add_special_tokens?: boolean;
  };

export function normalizeTokenizeRequest(
  request: TokenizeRequest | SnakeCaseTokenizeRequest | null | undefined
): (TokenizeRequest & UnknownRecord) | undefined {
  if (!isRecord(request)) {
    return undefined;
  }

  const normalized: UnknownRecord = {
    model: request.model,
    text: request.text,
  };
  const knownKeys = new Set<string>(['model', 'text']);

  applyCamelMappings(normalized, request, TOKENIZE_REQUEST_MAPPINGS);
  applyAliasMappings(normalized, request, TOKENIZE_ALIAS_KEYS);
  for (const alias of Object.keys(TOKENIZE_ALIAS_KEYS)) {
    knownKeys.add(alias);
  }
  for (const [camelKey, snakeKey] of TOKENIZE_REQUEST_MAPPINGS) {
    knownKeys.add(camelKey);
    knownKeys.add(snakeKey);
  }

  if (request.addBos !== undefined) {
    normalized.addBos = request.addBos;
  }

  copyUnknownKeys(normalized, request, knownKeys);

  return normalized as TokenizeRequest & UnknownRecord;
}

const TOKENIZE_ALIAS_KEYS: Record<string, keyof TokenizeRequest> = {
  model_id: 'model',
  add_special_tokens: 'addBos',
};

export function denormalizeTokenizeRequest(
  request: TokenizeRequest | SnakeCaseTokenizeRequest | null | undefined
): SnakeCaseTokenizeRequest | undefined {
  if (!isRecord(request)) {
    return undefined;
  }

  const denormalized: UnknownRecord = {
    model: request.model,
    text: request.text,
  };
  const knownKeys = new Set<string>(['model', 'text']);

  applySnakeMappings(denormalized, request, TOKENIZE_REQUEST_MAPPINGS);
  for (const [, snakeKey] of TOKENIZE_REQUEST_MAPPINGS) {
    knownKeys.add(snakeKey);
  }
  denormalized.model_id = request.model;
  knownKeys.add('model_id');
  if (request.addBos !== undefined) {
    denormalized.add_special_tokens = request.addBos;
    knownKeys.add('add_special_tokens');
  }

  copyUnknownKeys(denormalized, request, knownKeys);

  return denormalized as SnakeCaseTokenizeRequest;
}

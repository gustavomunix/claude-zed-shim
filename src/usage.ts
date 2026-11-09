export type OpenAIUsage = {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
    cache_write_tokens?: number;
  };
  completion_tokens_details?: {
    reasoning_tokens?: number;
  };
};

export function addUsage(acc: OpenAIUsage | null, delta: OpenAIUsage): OpenAIUsage {
  if (!acc) return { ...delta };
  const cached = (acc.prompt_tokens_details?.cached_tokens ?? 0) + (delta.prompt_tokens_details?.cached_tokens ?? 0);
  const cacheWrite =
    (acc.prompt_tokens_details?.cache_write_tokens ?? 0) + (delta.prompt_tokens_details?.cache_write_tokens ?? 0);
  const reasoning =
    (acc.completion_tokens_details?.reasoning_tokens ?? 0) +
    (delta.completion_tokens_details?.reasoning_tokens ?? 0);
  const promptDetails: NonNullable<OpenAIUsage["prompt_tokens_details"]> = {};
  if (cached > 0) promptDetails.cached_tokens = cached;
  if (cacheWrite > 0) promptDetails.cache_write_tokens = cacheWrite;
  return {
    prompt_tokens: acc.prompt_tokens + delta.prompt_tokens,
    completion_tokens: acc.completion_tokens + delta.completion_tokens,
    total_tokens: acc.total_tokens + delta.total_tokens,
    ...(Object.keys(promptDetails).length > 0 ? { prompt_tokens_details: promptDetails } : {}),
    ...(reasoning > 0 ? { completion_tokens_details: { reasoning_tokens: reasoning } } : {}),
  };
}

export function maxUsage(a: OpenAIUsage, b: OpenAIUsage): OpenAIUsage {
  const pick = (x?: number, y?: number) => Math.max(x ?? 0, y ?? 0);
  const cached = pick(a.prompt_tokens_details?.cached_tokens, b.prompt_tokens_details?.cached_tokens);
  const cacheWrite = pick(
    a.prompt_tokens_details?.cache_write_tokens,
    b.prompt_tokens_details?.cache_write_tokens,
  );
  const reasoning = pick(
    a.completion_tokens_details?.reasoning_tokens,
    b.completion_tokens_details?.reasoning_tokens,
  );
  const prompt = pick(a.prompt_tokens, b.prompt_tokens);
  const completion = pick(a.completion_tokens, b.completion_tokens);
  const promptDetails: NonNullable<OpenAIUsage["prompt_tokens_details"]> = {};
  if (cached > 0) promptDetails.cached_tokens = cached;
  if (cacheWrite > 0) promptDetails.cache_write_tokens = cacheWrite;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    ...(Object.keys(promptDetails).length > 0 ? { prompt_tokens_details: promptDetails } : {}),
    ...(reasoning > 0 ? { completion_tokens_details: { reasoning_tokens: reasoning } } : {}),
  };
}

export function usageGrowth(max: OpenAIUsage, baseline: OpenAIUsage | null): OpenAIUsage | null {
  if (!baseline) return { ...max };
  const diff = (x?: number, y?: number) => Math.max(0, (x ?? 0) - (y ?? 0));
  const prompt = diff(max.prompt_tokens, baseline.prompt_tokens);
  const completion = diff(max.completion_tokens, baseline.completion_tokens);
  const cached = diff(max.prompt_tokens_details?.cached_tokens, baseline.prompt_tokens_details?.cached_tokens);
  const cacheWrite = diff(
    max.prompt_tokens_details?.cache_write_tokens,
    baseline.prompt_tokens_details?.cache_write_tokens,
  );
  const reasoning = diff(
    max.completion_tokens_details?.reasoning_tokens,
    baseline.completion_tokens_details?.reasoning_tokens,
  );
  if (prompt + completion + cached + cacheWrite + reasoning === 0) return null;
  const promptDetails: NonNullable<OpenAIUsage["prompt_tokens_details"]> = {};
  if (cached > 0) promptDetails.cached_tokens = cached;
  if (cacheWrite > 0) promptDetails.cache_write_tokens = cacheWrite;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    ...(Object.keys(promptDetails).length > 0 ? { prompt_tokens_details: promptDetails } : {}),
    ...(reasoning > 0 ? { completion_tokens_details: { reasoning_tokens: reasoning } } : {}),
  };
}

function withPromptOf(usage: OpenAIUsage, call: OpenAIUsage): OpenAIUsage {
  const { prompt_tokens_details: _dropped, ...rest } = usage;
  return {
    ...rest,
    prompt_tokens: call.prompt_tokens,
    total_tokens: call.prompt_tokens + usage.completion_tokens,
    ...(call.prompt_tokens_details ? { prompt_tokens_details: { ...call.prompt_tokens_details } } : {}),
  };
}

export class TurnUsageTracker {
  private readonly byId = new Map<string, { baseline: OpenAIUsage | null; max: OpenAIUsage }>();
  private anonymous: OpenAIUsage | null = null;

  private readonly reported: Map<string, OpenAIUsage>;

  constructor(reported: Map<string, OpenAIUsage>) {
    this.reported = reported;
  }

  add(usage: OpenAIUsage, messageId: string | null): void {
    if (!messageId) {
      this.anonymous = addUsage(this.anonymous, usage);
      return;
    }
    let entry = this.byId.get(messageId);
    if (!entry) {
      const baseline = this.reported.get(messageId) ?? null;
      entry = { baseline, max: baseline ?? usage };
      this.byId.set(messageId, entry);
    }
    entry.max = maxUsage(entry.max, usage);
    this.reported.set(messageId, entry.max);
  }

  total(): OpenAIUsage | null {
    let sum = this.anonymous ? { ...this.anonymous } : null;
    let last: OpenAIUsage | null = null;
    for (const { baseline, max } of this.byId.values()) {
      last = max;
      const growth = usageGrowth(max, baseline);
      if (growth) sum = addUsage(sum, growth);
    }
    if (!sum || !last) return sum;
    return withPromptOf(sum, last);
  }
}

export function resolveTurnUsage(accumulated: OpenAIUsage | null, result: OpenAIUsage | null): OpenAIUsage | null {
  return accumulated ?? result;
}

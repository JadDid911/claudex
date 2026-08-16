const DEFAULT_WEIGHT = 1;
const MAX_COOLDOWN_MS = 60 * 60 * 1000;
const INITIAL_COOLDOWN_MS = 60 * 1000;

function toTimestamp(value) {
  if (typeof value === 'number') {
    return value;
  }

  if (typeof value === 'string') {
    return Date.parse(value);
  }

  if (value instanceof Date) {
    return value.getTime();
  }

  return Date.now();
}

function createProviderEntry(provider, options = {}) {
  return {
    provider,
    weight: Number.isFinite(options.weight) ? options.weight : DEFAULT_WEIGHT,
    availability: options.availability ?? 'available',
    busy: Boolean(options.busy),
    failureStreak: Number.isInteger(options.failureStreak) ? options.failureStreak : 0,
    cooldownUntil: options.cooldownUntil ?? null,
    cooldownMs: Number.isFinite(options.cooldownMs) ? options.cooldownMs : 0,
    observedTurns: Number.isInteger(options.observedTurns) ? options.observedTurns : 0,
    observedLeadTurns: Number.isInteger(options.observedLeadTurns) ? options.observedLeadTurns : 0,
    observedHelperTurns: Number.isInteger(options.observedHelperTurns)
      ? options.observedHelperTurns
      : 0,
    observedTokens: Number.isInteger(options.observedTokens) ? options.observedTokens : 0,
    lastTurnTokens: Number.isInteger(options.lastTurnTokens) ? options.lastTurnTokens : 0,
    usageStatus: options.usageStatus ?? null,
    usageScope: options.usageScope ?? null,
    usageResetsAt: options.usageResetsAt ?? null,
    usageRetryAfterSeconds: Number.isFinite(options.usageRetryAfterSeconds)
      ? options.usageRetryAfterSeconds
      : null,
    usageReportedAt: options.usageReportedAt ?? null,
    capacitySource: options.capacitySource ?? 'configured',
    workspaceStickiness: Number.isInteger(options.workspaceStickiness)
      ? options.workspaceStickiness
      : 0,
    sessionStickiness: Number.isInteger(options.sessionStickiness) ? options.sessionStickiness : 0,
    lastFailureKind: options.lastFailureKind ?? null,
    lastFailureAt: options.lastFailureAt ?? null,
    lastLeadAt: options.lastLeadAt ?? null,
    lastRole: options.lastRole ?? null,
  };
}

function ensureEntry(ledger, provider) {
  if (!ledger.providers[provider]) {
    ledger.providers[provider] = createProviderEntry(provider);
  }

  return ledger.providers[provider];
}

export function createCapacityLedger(options = {}) {
  const providers = Array.isArray(options.providers) && options.providers.length > 0
    ? options.providers
    : ['codex', 'claude'];

  const ledger = {
    providers: {},
    createdAt: options.createdAt ?? new Date().toISOString(),
    updatedAt: options.updatedAt ?? new Date().toISOString(),
  };

  for (const provider of providers) {
    const override = options.providerStates?.[provider] ?? {};
    const weight = options.weights?.[provider];
    ledger.providers[provider] = createProviderEntry(provider, {
      ...override,
      weight: Number.isFinite(weight) ? weight : override.weight,
    });
  }

  return ledger;
}

export function cloneCapacityLedger(ledger) {
  return createCapacityLedger({
    providers: Object.keys(ledger.providers),
    providerStates: structuredClone(ledger.providers),
    createdAt: ledger.createdAt,
    updatedAt: ledger.updatedAt,
  });
}

export function setProviderWeight(ledger, provider, weight) {
  const entry = ensureEntry(ledger, provider);
  entry.weight = Number.isFinite(weight) ? weight : DEFAULT_WEIGHT;
  ledger.updatedAt = new Date().toISOString();
  return entry;
}

export function setProviderAvailability(ledger, provider, availability) {
  const entry = ensureEntry(ledger, provider);
  entry.availability = availability ?? 'available';
  ledger.updatedAt = new Date().toISOString();
  return entry;
}

export function setProviderBusy(ledger, provider, busy) {
  const entry = ensureEntry(ledger, provider);
  entry.busy = Boolean(busy);
  ledger.updatedAt = new Date().toISOString();
  return entry;
}

export function setProviderStickiness(
  ledger,
  provider,
  { workspaceStickiness = 0, sessionStickiness = 0 } = {},
) {
  const entry = ensureEntry(ledger, provider);
  entry.workspaceStickiness = workspaceStickiness;
  entry.sessionStickiness = sessionStickiness;
  ledger.updatedAt = new Date().toISOString();
  return entry;
}

export function isCapacityFailure(kind) {
  return ['capacity', 'quota', 'rate-limit', 'rate_limit'].includes(kind);
}

export function recordProviderTurn(ledger, provider, details = {}) {
  const entry = ensureEntry(ledger, provider);
  entry.lastTurnTokens = Math.max(0, details.tokens ?? 0);
  entry.observedTurns += 1;
  entry.observedTokens += entry.lastTurnTokens;
  entry.lastRole = details.role ?? 'lead';
  entry.lastLeadAt = details.role === 'lead' ? details.at ?? new Date().toISOString() : entry.lastLeadAt;

  if (details.role === 'lead') {
    entry.observedLeadTurns += 1;
  } else {
    entry.observedHelperTurns += 1;
  }

  if (entry.capacitySource === 'configured') {
    entry.capacitySource = 'observed';
  }

  ledger.updatedAt = new Date().toISOString();
  return entry;
}

export function recordProviderUsageLimit(ledger, provider, details = {}) {
  const entry = ensureEntry(ledger, provider);
  entry.usageStatus = details.status ? String(details.status).slice(0, 64) : null;
  entry.usageScope = details.scope ? String(details.scope).slice(0, 128) : null;
  entry.usageResetsAt = details.resetsAt ? String(details.resetsAt).slice(0, 128) : null;
  entry.usageRetryAfterSeconds = Number.isFinite(details.retryAfterSeconds)
    ? Math.max(0, details.retryAfterSeconds)
    : null;
  entry.usageReportedAt = details.reportedAt ?? new Date().toISOString();
  ledger.updatedAt = entry.usageReportedAt;
  return entry;
}

export function recordProviderSuccess(ledger, provider) {
  const entry = ensureEntry(ledger, provider);
  entry.failureStreak = 0;
  entry.lastFailureKind = null;
  entry.cooldownMs = 0;
  entry.cooldownUntil = null;
  ledger.updatedAt = new Date().toISOString();
  return entry;
}

export function recordProviderFailure(ledger, provider, details = {}) {
  const entry = ensureEntry(ledger, provider);
  const now = toTimestamp(details.now);
  const kind = details.kind ?? 'error';

  entry.failureStreak += 1;
  entry.lastFailureKind = kind;
  entry.lastFailureAt = new Date(now).toISOString();

  if (isCapacityFailure(kind)) {
    const nextCooldown = entry.cooldownMs > 0
      ? Math.min(entry.cooldownMs * 2, MAX_COOLDOWN_MS)
      : INITIAL_COOLDOWN_MS;

    entry.cooldownMs = nextCooldown;
    entry.cooldownUntil = new Date(now + nextCooldown).toISOString();
  }

  ledger.updatedAt = new Date(now).toISOString();
  return entry;
}

export function getProviderStatus(ledger, provider, details = {}) {
  const entry = ensureEntry(ledger, provider);
  const now = toTimestamp(details.now);
  const cooldownUntil = entry.cooldownUntil ? Date.parse(entry.cooldownUntil) : null;
  const inCooldown = Number.isFinite(cooldownUntil) ? cooldownUntil > now : false;

  return {
    ...entry,
    available: entry.availability === 'available',
    inCooldown,
    cooldownRemainingMs: inCooldown ? cooldownUntil - now : 0,
    canLead: entry.availability === 'available' && !entry.busy && !inCooldown,
  };
}

export function getCapacitySnapshot(ledger, details = {}) {
  const now = toTimestamp(details.now);
  const providers = {};

  for (const provider of Object.keys(ledger.providers)) {
    providers[provider] = getProviderStatus(ledger, provider, { now });
  }

  return {
    createdAt: ledger.createdAt,
    updatedAt: ledger.updatedAt,
    providers,
  };
}

/**
 * Mutable convenience wrapper around the capacity ledger state.
 */
export class CapacityLedger {
  /**
   * @param {Parameters<typeof createCapacityLedger>[0]} [options]
   */
  constructor(options = {}) {
    this.state = createCapacityLedger(options);
  }

  /**
   * @param {string} provider
   * @param {number} weight
   */
  setWeight(provider, weight) {
    return setProviderWeight(this.state, provider, weight);
  }

  /**
   * @param {string} provider
   * @param {string} availability
   */
  setAvailability(provider, availability) {
    return setProviderAvailability(this.state, provider, availability);
  }

  /**
   * @param {string} provider
   * @param {boolean} busy
   */
  setBusy(provider, busy) {
    return setProviderBusy(this.state, provider, busy);
  }

  /**
   * @param {string} provider
   * @param {{workspaceStickiness?: number, sessionStickiness?: number}} values
   */
  setStickiness(provider, values) {
    return setProviderStickiness(this.state, provider, values);
  }

  /**
   * @param {string} provider
   * @param {{role?: string, tokens?: number, at?: string}} details
   */
  recordTurn(provider, details = {}) {
    return recordProviderTurn(this.state, provider, details);
  }

  recordUsageLimit(provider, details = {}) {
    return recordProviderUsageLimit(this.state, provider, details);
  }

  /**
   * @param {string} provider
   */
  recordSuccess(provider) {
    return recordProviderSuccess(this.state, provider);
  }

  /**
   * @param {string} provider
   * @param {{kind?: string, now?: string | number | Date}} [details]
   */
  recordFailure(provider, details = {}) {
    return recordProviderFailure(this.state, provider, details);
  }

  /**
   * @param {string} provider
   * @param {{now?: string | number | Date}} [details]
   */
  status(provider, details = {}) {
    return getProviderStatus(this.state, provider, details);
  }

  /**
   * @param {{now?: string | number | Date}} [details]
   */
  snapshot(details = {}) {
    return getCapacitySnapshot(this.state, details);
  }
}

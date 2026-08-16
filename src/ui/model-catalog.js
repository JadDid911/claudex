import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { normalizeProviderEffort } from '../core/preferences.js';

const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/u;
const CLAUDE_EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);
const CLAUDE_MODELS = [
  { id: 'default', description: 'Use the Claude subscription default.' },
  { id: 'fable', description: 'Latest Fable available to this Claude account.', contextWindow: 1_000_000 },
  { id: 'opus', description: 'Latest Opus available to this Claude account.', contextWindow: 1_000_000 },
  { id: 'sonnet', description: 'Latest Sonnet available to this Claude account.', contextWindow: 1_000_000 },
  { id: 'claude-fable-5', description: 'Versioned Fable 5 · highest-capability long-running agents.', contextWindow: 1_000_000 },
  { id: 'claude-opus-5', description: 'Versioned Opus 5 · complex agentic coding and enterprise work.', contextWindow: 1_000_000 },
  { id: 'claude-opus-4-8', description: 'Versioned Opus 4.8.', contextWindow: 1_000_000 },
  { id: 'claude-opus-4-7', description: 'Versioned Opus 4.7.', contextWindow: 1_000_000 },
  { id: 'claude-opus-4-6', description: 'Versioned Opus 4.6.', contextWindow: 1_000_000 },
  { id: 'claude-opus-4-5', description: 'Versioned Opus 4.5.', contextWindow: 200_000 },
  { id: 'claude-sonnet-5', description: 'Versioned Sonnet 5 · fast intelligence/cost balance.', contextWindow: 1_000_000 },
  { id: 'claude-sonnet-4-6', description: 'Versioned Sonnet 4.6.', contextWindow: 1_000_000 },
  { id: 'claude-sonnet-4-5', description: 'Versioned Sonnet 4.5 alias.', contextWindow: 200_000 },
  { id: 'claude-haiku-4-5', description: 'Versioned Haiku 4.5 alias · fastest current Haiku.', contextWindow: 200_000 },
].map((model) => ({
  ...model,
  efforts: model.id === 'default' ? undefined : [...CLAUDE_EFFORTS],
}));

export async function loadLocalModelCatalog(options = {}) {
  const env = options.env ?? process.env;
  const homeDirectory = options.homeDirectory ?? os.homedir();
  const readText = options.readText ?? ((filePath) => readFile(filePath, 'utf8'));
  const codexHome = env.CODEX_HOME
    ? path.resolve(env.CODEX_HOME)
    : path.join(homeDirectory, '.codex');
  const codexModels = [
    { id: 'default', description: 'Use the Codex subscription default.' },
  ];

  try {
    const cache = JSON.parse(await readText(path.join(codexHome, 'models_cache.json')));
    for (const model of Array.isArray(cache?.models) ? cache.models : []) {
      const id = firstModelId(model);
      if (!id || id === 'default' || model?.visibility === 'hide') continue;
      codexModels.push({
        id,
        description: singleLine(model?.description ?? model?.display_name ?? 'Codex model.'),
        efforts: sanitizeEfforts(model?.supported_reasoning_levels),
        defaultEffort: sanitizeEffort(model?.default_reasoning_level),
        contextWindow: positiveInteger(model?.context_window),
        effectiveContextPercent: boundedPercent(model?.effective_context_window_percent),
      });
    }
  } catch {
    // The official CLI cache is optional and can change shape; custom IDs still work.
  }

  return {
    codex: dedupeModels(codexModels),
    claude: CLAUDE_MODELS.map((model) => ({
      ...model,
      efforts: model.efforts ? [...model.efforts] : undefined,
    })),
  };
}

export function enrichStatusWithModelCatalog(status = {}, catalog = {}) {
  return {
    ...status,
    providers: (status.providers ?? []).map((provider) => {
      const selected = (catalog?.[provider.name] ?? []).find(
        (model) => model.id === provider.model,
      );
      return {
        ...provider,
        modelContextTokens: selected?.contextWindow ?? null,
        effectiveContextPercent: selected?.effectiveContextPercent ?? null,
        sharedContextBytes: status.contextCapBytes ?? provider.contextCapBytes ?? null,
      };
    }),
  };
}

function firstModelId(model) {
  for (const candidate of [model?.slug, model?.id, model?.name]) {
    const id = String(candidate ?? '').trim();
    if (MODEL_ID_PATTERN.test(id)) return id;
  }
  return null;
}

function singleLine(value) {
  return String(value ?? '')
    .replace(/[\r\n\t]+/gu, ' ')
    .replace(/\s{2,}/gu, ' ')
    .trim()
    .slice(0, 120);
}

function sanitizeEfforts(levels) {
  if (!Array.isArray(levels)) return undefined;
  const seen = new Set();
  const efforts = [];
  for (const level of levels) {
    const effort = sanitizeEffort(level?.effort ?? level);
    if (!effort || seen.has(effort)) continue;
    seen.add(effort);
    efforts.push(effort);
  }
  return efforts.length > 0 ? efforts : undefined;
}

function sanitizeEffort(value) {
  return normalizeProviderEffort('codex', value) ?? undefined;
}

function positiveInteger(value) {
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

function boundedPercent(value) {
  return Number.isFinite(value) && value > 0 && value <= 100 ? value : undefined;
}

function dedupeModels(models) {
  const seen = new Set();
  return models.filter((model) => {
    if (seen.has(model.id)) return false;
    seen.add(model.id);
    return true;
  });
}

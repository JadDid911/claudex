import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { normalizeProviderEffort } from '../core/preferences.js';

const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/u;
const CLAUDE_ALIASES = [
  { id: 'default', description: 'Use the Claude subscription default.' },
  { id: 'opus', description: 'Claude CLI model alias.' },
  { id: 'sonnet', description: 'Claude CLI model alias.' },
  { id: 'fable', description: 'Claude CLI model alias.' },
];

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
      });
    }
  } catch {
    // The official CLI cache is optional and can change shape; custom IDs still work.
  }

  return {
    codex: dedupeModels(codexModels),
    claude: CLAUDE_ALIASES.map((model) => ({ ...model })),
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

function dedupeModels(models) {
  const seen = new Set();
  return models.filter((model) => {
    if (seen.has(model.id)) return false;
    seen.add(model.id);
    return true;
  });
}

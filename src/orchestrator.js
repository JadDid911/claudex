import { realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createProviderEnvironment, loadEffectiveConfig, saveConfig } from './config.js';
import {
  createCapacityLedger,
  getCapacitySnapshot,
  recordProviderFailure,
  recordProviderSuccess,
  recordProviderTurn,
  recordProviderUsageLimit,
  setProviderAvailability,
  setProviderBusy,
  setProviderStickiness,
  setProviderWeight,
} from './core/capacity.js';
import { buildContextPacket } from './core/context.js';
import { writeDiagnosticsBundle } from './core/diagnostics.js';
import { buildRoomMemory, mergeProjectMemory } from './core/memory.js';
import {
  normalizeDelegationMode,
  normalizeModeProvider,
  normalizeModeProviderLane,
  normalizeProviderEffort,
} from './core/preferences.js';
import {
  assignComplementaryRoles,
  createDispatchPlan,
  createSupermodePlan,
} from './core/scheduler.js';
import { createRoomStore, normalizeWorkspacePath, resumeRoomStore } from './core/store.js';
import { checkForUpdate } from './core/update.js';
import { inspectWorkspace } from './core/workspace-inspection.js';
import { WriteLease } from './core/write-lease.js';
import { resolveCommand } from './process/resolve-command.js';
import { createClaudeProvider } from './providers/claude.js';
import { createCodexProvider } from './providers/codex.js';
import { ROOM_CLARIFICATION_PREFIX } from './providers/base.js';
import { isPlainTextTurn } from './ui/commands.js';

const PROVIDER_NAMES = ['codex', 'claude'];
const TERMINAL_SUCCESS = 'completed';
const MAX_CONTEXT_EVENTS = 512;
const MAX_CLARIFICATION_ROUNDS = 4;
const MAX_PLAN_APPROVAL_ROUNDS = 4;
const SUPERMODE_STAGE_LABELS = Object.freeze({
  plan: 'Plan',
  ux: 'UX guidance',
  code: 'Code',
  execute: 'Execute & verify',
  review: 'Final review',
});

function isoNow(now) {
  const value = now();
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function actorFor(provider) {
  return String(provider ?? 'system').toUpperCase();
}

function roleAction(role, fallback) {
  const actions = {
    'planning-lead': 'plans',
    'plan-critic': 'challenges',
    'coding-lead': 'codes',
    'code-reviewer': 'reviews',
    'execution-lead': 'executes',
    verifier: 'verifies',
    'ui-implementation-lead': 'builds UI',
    'ux-implementation-lead': 'builds UX',
    'ux-reviewer': 'checks UX',
    'implementation-lead': 'writes',
    'read-only-reviewer': 'reviews',
    'debugging-lead': 'diagnoses',
    'independent-root-cause-reviewer': 'cross-checks',
    'technical-audit-lead': 'audits',
    'technical-audit-checker': 'cross-checks',
    'security-review-lead': 'audits security',
    'security-review-checker': 'cross-checks security',
    'code-review-lead': 'reviews code',
    'code-review-checker': 'cross-checks code',
    'test-review-lead': 'reviews tests',
    'test-review-checker': 'cross-checks tests',
    'specialist-review-lead': 'reviews',
    'independent-checker': 'checks',
    'analysis-lead': 'analyzes',
    'independent-analyst': 'cross-checks',
    'direct-turn': 'answers',
    'secondary-visible-participant': 'helps',
  };
  return actions[role] ?? fallback;
}

function normalizeProviderObjective(objective, classification) {
  const text = String(objective ?? '');
  if (classification?.kind !== 'review' || classification.reviewFocus === 'ux') {
    return text;
  }

  return text
    .replace(/\bauditing\b/giu, 'reviewing')
    .replace(/\baudited\b/giu, 'reviewed')
    .replace(/\baudits\b/giu, 'reviews')
    .replace(/\baudit\b(?!\s+(?:log|logs|trail|trails|event|events|record|records)\b)/giu, 'engineering review');
}

function isContextOnlyDirectObjective(objective) {
  const text = String(objective ?? '').trim();
  if (text.length < 160 || /\?/u.test(text)) return false;
  return !(
    /^(?:please\s+)?(?:explain|summarize|rewrite|draft|analyze|review|check|fix|build|create|implement|change|edit|plan|compare|list|tell|show|help)\b/iu.test(text) ||
    /\b(?:can|could|would|will) you\b|\bi (?:want|need|would like) you to\b|\bplease\b/iu.test(text)
  );
}

function readOnlyAssignmentPrompt(assignment, objective) {
  const scope = assignment.reviewFocus;
  const header = `Act as ${assignment.role}. Do not modify the workspace.`;
  const objectiveLine = `Objective: ${objective}`;

  if (assignment.role === 'planning-lead' && assignment.label === 'plan') {
    return [
      `${header} Produce a concrete, implementation-ready plan for the remaining Supermode stages.`,
      objectiveLine,
      'Inspect the workspace as needed, identify the smallest safe change, name verification steps, and surface material risks.',
      'Return the plan itself. Do not tell the user to run /execute or any other Claudex command; Claudex presents the next-stage controls separately.',
      `If a required user decision truly blocks progress, ask exactly one direct question prefixed with "${ROOM_CLARIFICATION_PREFIX}". Otherwise return the plan without asking optional questions.`,
    ].join('\n\n');
  }

  if (assignment.label === 'review') {
    return [
      `${header} Perform the final independent review after plan, UX guidance, code, and execute stages.`,
      objectiveLine,
      'Inspect the current workspace and verification evidence. Return the final user-facing verdict with concrete correctness, regression, safety, or completeness findings; do not modify files.',
    ].join('\n\n');
  }

  if (scope === 'general-audit') {
    return [
      `${header} Conduct a broad engineering/non-UI audit of the requested target.`,
      'Do not default to a frontend, UI, UX, accessibility, responsive-layout, or visual-design workflow unless the objective explicitly asks for one.',
      'Assess architecture, correctness, security, data integrity, reliability, recovery, testing, performance, dependencies, deployment, and operations as relevant. Honor any narrower scope named in the objective.',
      objectiveLine,
      'Return concise, evidence-backed findings for the lead, ordered by severity.',
    ].join('\n\n');
  }

  if (scope === 'security') {
    return [
      `${header} Conduct a security-focused engineering review.`,
      'Inspect trust boundaries, authentication, authorization, input handling, secrets, data exposure, and abuse or recovery paths as relevant. Do not turn this into a visual-design review.',
      objectiveLine,
      'Return concise, evidence-backed findings for the lead, ordered by severity.',
    ].join('\n\n');
  }

  if (scope === 'code-review') {
    return [
      `${header} Conduct a code-focused engineering review.`,
      'Inspect correctness, behavior changes, maintainability, API contracts, data flow, and regression risk. Do not turn this into a visual-design review unless explicitly requested.',
      objectiveLine,
      'Return concise, evidence-backed findings for the lead, ordered by severity.',
    ].join('\n\n');
  }

  if (scope === 'test-review') {
    return [
      `${header} Conduct a test and verification review.`,
      'Inspect coverage, assertions, failure paths, determinism, integration boundaries, and unmodeled production risks. Do not turn this into a visual-design review.',
      objectiveLine,
      'Return concise, evidence-backed findings for the lead, ordered by severity.',
    ].join('\n\n');
  }

  if (scope === 'ux') {
    return [
      `${header} Conduct the requested UI/UX review.`,
      objectiveLine,
      'Return concise, evidence-backed findings for the lead, ordered by severity.',
    ].join('\n\n');
  }

  if (assignment.role === 'direct-turn' && isContextOnlyDirectObjective(objective)) {
    return [
      `${header} The user supplied context without a clear requested outcome.`,
      objectiveLine,
      'Do not repeat or paraphrase the supplied context as the answer.',
      `Ask exactly one concise blocking question about the intended outcome, prefixed with "${ROOM_CLARIFICATION_PREFIX}". Offer useful choices such as analyze, rewrite, plan next steps, or retain as context.`,
    ].join('\n\n');
  }

  return [
    `${header} ${assignment.role === 'direct-turn' ? 'Answer the objective directly.' : 'Provide concise findings for the lead.'}`,
    objectiveLine,
    assignment.role === 'direct-turn'
      ? 'Stay concise. Do not reframe the turn as a review, and do not modify the workspace.'
      : 'Do not modify the workspace.',
  ].join('\n\n');
}

function writeAssignmentPrompt(assignment, objective) {
  if (assignment.label === 'code') {
    return [
      'Implement the approved plan now. Do not stop after planning or describing intended edits.',
      `Objective: ${objective}`,
      'Use the supplied plan and UX guidance, modify the workspace, and complete the requested code and UI work.',
      `Choose reasonable defaults for nonessential preferences. Only ask a blocking question when safe progress is impossible, prefixed with "${ROOM_CLARIFICATION_PREFIX}".`,
    ].join('\n\n');
  }

  if (assignment.label !== 'execute') {
    return objective;
  }

  return [
    'Execute and verify the implemented work now. Do not restart planning or merely describe intended checks.',
    `Objective: ${objective}`,
    'Inspect the code-stage result, run focused verification, and fix any remaining correctness or completeness problems.',
    `Choose reasonable defaults for missing nonessential product or design preferences and proceed. Only when a required decision makes safe progress impossible, ask exactly one direct question prefixed with "${ROOM_CLARIFICATION_PREFIX}".`,
  ].join('\n\n');
}

function canonicalPathForComparison(value) {
  const normalized = normalizeWorkspacePath(value);
  try {
    return normalizeWorkspacePath(realpathSync.native(normalized));
  } catch {
    return normalized;
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function userTurnRoute(command) {
  if (command.supermode) return 'supermode';
  if (command.route && command.route !== 'auto') return command.route;
  return normalizeDelegationMode(command.delegationMode, 'auto');
}

function usageTokens(usage) {
  if (!usage || typeof usage !== 'object') {
    return 0;
  }

  const valueFor = (...keys) => {
    for (const key of keys) {
      const value = usage[key];
      if (typeof value === 'number' && Number.isFinite(value)) {
        return Math.max(0, value);
      }
    }
    return null;
  };
  const total = valueFor('total_tokens', 'totalTokens');
  if (total !== null) return total;

  const input = valueFor('input_tokens', 'inputTokens', 'prompt_tokens', 'promptTokens') ?? 0;
  const output = valueFor(
    'output_tokens',
    'outputTokens',
    'completion_tokens',
    'completionTokens',
  ) ?? 0;
  const claudeCacheCreation = valueFor('cache_creation_input_tokens', 'cacheCreationInputTokens') ?? 0;
  const claudeCacheRead = valueFor('cache_read_input_tokens', 'cacheReadInputTokens') ?? 0;
  return input + output + claudeCacheCreation + claudeCacheRead;
}

function formatByteCount(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return 'unknown';
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KiB`;
  return `${Math.round(bytes)} B`;
}

function formatWorkspaceSummary(inspection = {}) {
  if (inspection.status !== 'git') return 'not a Git repository';
  const counts = inspection.counts ?? {};
  return [
    inspection.branch ? `branch ${inspection.branch}` : 'detached or unborn branch',
    `${counts.staged ?? 0} staged`,
    `${counts.modified ?? 0} modified`,
    `${counts.untracked ?? 0} untracked`,
    `${counts.conflicted ?? 0} conflicted`,
  ].join(' · ');
}

function formatPrivateStatePath(outputPath, storageRoot) {
  const relative = path.relative(storageRoot, outputPath);
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
    return path.join('<state>', relative);
  }
  return path.join('<private-state>', path.basename(outputPath));
}

function failureKind(result) {
  if (result?.status === 'capacity') {
    return 'capacity';
  }

  const code = String(result?.error?.code ?? '').toLowerCase();
  const message = String(result?.error?.message ?? '').toLowerCase();
  const warningCodes = (result?.events ?? [])
    .filter((event) => event.type === 'warning')
    .map((event) => String(event.code ?? '').toLowerCase());

  if (
    code.includes('rate') ||
    code.includes('quota') ||
    warningCodes.some((entry) => entry.includes('rate') || entry.includes('quota')) ||
    /rate.?limit|quota|capacity/iu.test(message)
  ) {
    return 'rate-limit';
  }

  return result?.status ?? 'error';
}

function parseExplicitClarification(text) {
  const prefix = ROOM_CLARIFICATION_PREFIX.toLowerCase();
  const prefixIndex = text.toLowerCase().lastIndexOf(prefix);
  const prefixBoundary = prefixIndex === 0 || (
    prefixIndex > 0 && /(?:[.!][ \t]+|\r?\n+)\s*$/u.test(text.slice(0, prefixIndex))
  );
  if (!prefixBoundary) return null;

  const remainder = text.slice(prefixIndex + ROOM_CLARIFICATION_PREFIX.length).trim();
  const lines = remainder.split(/\r?\n/gu).map((line) => line.trim());
  const questionIndex = lines.findIndex(Boolean);
  if (questionIndex < 0) return null;
  const question = lines[questionIndex];
  if (!question.endsWith('?') || (question.match(/\?/gu) ?? []).length !== 1) return null;

  const optionLines = lines.slice(questionIndex + 1);
  const optionsHeading = optionLines.findIndex((line) => /^options?:$/iu.test(line));
  const candidates = (optionsHeading >= 0 ? optionLines.slice(optionsHeading + 1) : optionLines)
    .map((line) => line.match(/^(?:[-*]\s+|\d{1,2}[.)]\s+)(.+)$/u)?.[1]?.trim() ?? '')
    .filter(Boolean)
    .slice(0, 6);
  const options = [...new Set(candidates)];

  return { question, options };
}

function finalQuestionFrom(text) {
  const paragraphs = text.split(/\n\s*\n/gu).map((part) => part.trim()).filter(Boolean);
  const finalParagraph = paragraphs.at(-1) ?? '';
  let start = 0;
  for (const boundary of finalParagraph.matchAll(/(?:[.!][ \t]+|\r?\n+)/gu)) {
    start = boundary.index + boundary[0].length;
  }
  return finalParagraph.slice(start).trim();
}

export function parseClarificationRequest(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;

  const explicit = parseExplicitClarification(text);
  if (explicit) return explicit;
  if (!isLegacyClarificationRequest(text)) return null;
  return { question: finalQuestionFrom(text), options: [] };
}

export function isClarificationRequest(value) {
  return parseClarificationRequest(value) !== null;
}

function isLegacyClarificationRequest(value) {
  const text = String(value ?? '').trim();
  if (!text || !text.endsWith('?')) {
    return false;
  }

  const prefix = ROOM_CLARIFICATION_PREFIX.toLowerCase();
  const prefixIndex = text.toLowerCase().lastIndexOf(prefix);
  const prefixBoundary = prefixIndex === 0 || (
    prefixIndex > 0 && /(?:[.!][ \t]+|\r?\n+)\s*$/u.test(text.slice(0, prefixIndex))
  );
  if (prefixBoundary) {
    const question = text.slice(prefixIndex + ROOM_CLARIFICATION_PREFIX.length).trim();
    return Boolean(question) && question.endsWith('?') && (question.match(/\?/gu) ?? []).length === 1;
  }

  const paragraphs = text.split(/\n\s*\n/gu).map((part) => part.trim()).filter(Boolean);
  const finalParagraph = paragraphs.at(-1) ?? '';
  let finalQuestionStart = 0;
  for (const boundary of finalParagraph.matchAll(/(?:[.!][ \t]+|\r?\n+)/gu)) {
    finalQuestionStart = boundary.index + boundary[0].length;
  }
  const finalQuestion = finalParagraph.slice(finalQuestionStart).trim();

  if (text.length > 1_200 || /```/u.test(text)) {
    return false;
  }

  if (!finalQuestion.endsWith('?') || (text.match(/\?/gu) ?? []).length !== 1) {
    return false;
  }

  const question = finalQuestion;
  const directQuestion = /^(?:what|which|who|where|when|how|can|could|would|will|do|does|did|is|are|should|may|must)\b/iu.test(
    question,
  );
  const asksForInput = /\b(?:specify|choose|provide|confirm|clarify|select|name|identify|share|tell me|let me know|paste|attach|send)\b/iu.test(
    question,
  );
  const namesRequirement = /\b(?:requirements?|scope|target|audience|player|genre|action|platform|format|framework|language|model|provider|file|folder|path|repo|repository|project|endpoint|api|payload|input|output|style|tone|color|layout|design|native|web|mobile|desktop|browser|app|game|clip|video|audio|duration|volume)\b/iu.test(
    question,
  );
  const legacyRequirementQuestion = /^(?:what|which)\b.*\bshould\s+(?:i|we)\s+(?:use|choose|select|edit|inspect|change|build|implement|target|configure|open|create|update|remove|run|test|verify|deploy)\b/iu.test(
    question,
  ) && namesRequirement;
  const offersUserChoice = /^(?:do|would)\s+you\s+(?:choose|like|prefer|want)\b.*\b(?:or|versus|vs\.)\b/iu.test(
    question,
  );
  const offersRequirementChoice = /^(?:which\b.*\bshould\s+(?:i|we)\s+(?:use|choose|select|edit|inspect|change|build|implement|target|configure|open|create|update|remove|run|test|verify|deploy)|should\s+(?:i|we)\s+(?:use|choose|select|edit|inspect|change|build|implement|target|configure|open|create|update|remove|run|test|verify|deploy))\b.*\b(?:or|versus|vs\.)\b/iu.test(
    question,
  ) && namesRequirement;
  const soundsRhetorical = /\b(?:possibly|ever|on earth|in the world|who knows|why bother)\b/iu.test(
    question,
  );
  const preamble = text.slice(0, Math.max(0, text.lastIndexOf(finalQuestion))).trim();
  const signalsBlockedWork = /\b(?:(?:i|we)\s+(?:have not|haven't)\s+(?:started|begun)\s+(?:the\s+)?(?:implementation|requested\s+(?:work|change|changes)|task|build)|(?:i|we)\s+(?:cannot|can't|am unable to|are unable to)\s+(?:start|begin|proceed|continue|implement|build|complete|finish)|(?:i|we)\s+(?:need|require)\s+(?:your|the user's)\s+(?:input|decision|choice|answer|confirmation)|before\s+(?:i|we)\s+can\s+(?:start|begin|proceed|continue|implement|build|complete|finish))\b/iu.test(
    preamble,
  );
  const signalsCompletedOrOptionalWork = /\b(?:completed|finished|fixed|resolved|done|optional|if you want|next|tests?\s+(?:pass|passed)|verification\s+(?:pass|passed))\b/iu.test(
    preamble,
  );

  if (preamble && signalsBlockedWork && !signalsCompletedOrOptionalWork) {
    return directQuestion && !soundsRhetorical && (
      asksForInput || namesRequirement || offersUserChoice || offersRequirementChoice
    );
  }

  if (paragraphs.length !== 1 || finalQuestionStart > 0) {
    return false;
  }

  return directQuestion && !soundsRhetorical && (
    asksForInput || legacyRequirementQuestion || offersUserChoice || offersRequirementChoice
  );
}

function createLinkedAbortController(parentSignal) {
  const controller = new AbortController();
  const abort = () => {
    if (!controller.signal.aborted) {
      controller.abort(parentSignal?.reason ?? 'cancelled');
    }
  };

  if (parentSignal?.aborted) {
    abort();
  } else {
    parentSignal?.addEventListener('abort', abort, { once: true });
  }

  return {
    controller,
    dispose() {
      parentSignal?.removeEventListener('abort', abort);
    },
  };
}

function providerEventToCanonical(provider, event, turnId, taskId, label, options = {}) {
  const metadata = {
    label,
    providerEventType: event.type ?? 'unknown',
    ...(options.intermediate ? { intermediate: true } : {}),
  };
  let type = 'status';
  let content = '';

  if (event.type === 'text.delta') {
    type = 'delta';
    content = event.text ?? '';
  } else if (event.type === 'text.message') {
    type = 'message';
    content = event.text ?? '';
  } else if (event.type === 'activity') {
    type = 'activity';
    content = event.status ?? event.message ?? 'Working...';
  } else if (String(event.type).startsWith('tool.')) {
    type = 'tool';
    content = event.command ?? event.tool ?? 'tool';
    metadata.phase = String(event.type).slice('tool.'.length);
    metadata.tool = event.tool ?? 'tool';
    metadata.detail = event.command ?? event.output ?? event.delta ?? null;
  } else if (event.type === 'warning') {
    type = 'warning';
    content = event.message ?? event.code ?? 'Provider warning';
    metadata.code = event.code ?? null;
  } else if (event.type === 'error') {
    type = 'warning';
    content = event.message ?? 'Provider error';
    metadata.code = event.code ?? 'provider-error';
  } else if (event.type === 'session') {
    content = 'Provider session handle updated.';
  } else if (event.type === 'usage') {
    content = 'Provider usage observed.';
    metadata.usage = event.usage ?? null;
  } else if (event.type === 'turn.start') {
    content = 'Provider turn started.';
  } else if (event.type === 'turn.finish') {
    content = 'Provider turn completed.';
  } else {
    type = 'warning';
    content = `Unknown provider event: ${event.rawType ?? event.type ?? 'unknown'}`;
  }

  return {
    input: {
      actor: actorFor(provider),
      type,
      turnId,
      taskId,
      content,
      metadata,
    },
    display: {
      label,
      phase: metadata.phase,
      name: metadata.tool,
      detail: metadata.detail,
    },
  };
}

function replayDisplayEvent(event) {
  return {
    ...event,
    label: event.metadata?.label ?? null,
    phase: event.metadata?.phase,
    name: event.metadata?.tool,
    detail: event.metadata?.detail,
  };
}

function isDurableTranscriptEvent(event) {
  return event?.type === 'message' || event?.type === 'warning';
}

function contextTruncationNeedsWarning(context) {
  const details = context?.packet?.truncation;
  if (!details || typeof details !== 'object') return false;
  return Object.keys(details).some((key) => key !== 'droppedTranscriptEvents');
}

function detectRoomQuery(prompt) {
  const text = String(prompt ?? '').trim();
  if (!text || text.length > 240) {
    return null;
  }

  const normalized = text.toLowerCase();
  const hasFollowupTask =
    /(?:,|;|\b(?:and|then|also)\b)\s*(?:if\s+not\s+)?(?:(?:can|could|would|will)\s+you\s+)?(?:please\s+)?(?:build|change|fix|implement|refactor|write|create|add|update|remove|delete|edit|modify|apply|rename|move|run|execute|test|review|inspect|analyze|explain|summarize|commit|push|deploy)\b/u.test(normalized);
  if (hasFollowupTask) {
    return null;
  }

  if (
    /\b(?:can|does|do|will)\b.*\b(?:codex|claude|they|providers?)\b.*\b(?:see|read|share|know)\b.*\b(?:claude|codex|each other|messages?|transcript|context)\b/u.test(normalized) ||
    /\b(?:codex|claude)\b.*\b(?:see|read|share|know)\b.*\b(?:messages?|transcript|context|what)\b/u.test(normalized)
  ) {
    return { type: 'shared-context' };
  }
  if (/\bis\s+claude\b.*\b(?:in the room|with us|available|here|present)\b/u.test(normalized)) {
    return { type: 'provider-presence', provider: 'claude' };
  }
  if (/\bis\s+codex\b.*\b(?:in the room|with us|available|here|present)\b/u.test(normalized)) {
    return { type: 'provider-presence', provider: 'codex' };
  }
  if (
    /\b(?:who|which|what)\b.*\b(?:providers?|models?)\b.*\b(?:available|here|present|in the room)\b/u.test(normalized) ||
    /\bwho(?:'s| is)?\s+in\s+the\s+room\b/u.test(normalized)
  ) {
    return { type: 'provider-roster' };
  }

  return null;
}

function maximumTurnCounter(roomId, turnIds) {
  const prefix = `${roomId}-turn-`;
  let maximum = 0;

  for (const turnId of turnIds) {
    if (typeof turnId !== 'string' || !turnId.startsWith(prefix)) continue;
    const suffix = Number(turnId.slice(prefix.length));
    if (Number.isInteger(suffix) && suffix > maximum) maximum = suffix;
  }

  return maximum;
}

function buildDefaultProviders(config, sourceEnvironment) {
  const providerEnvironment = createProviderEnvironment(
    sourceEnvironment,
    config.environmentPassThrough,
  );
  return {
    codex: createCodexProvider({
      env: providerEnvironment,
      command: config.codex.executable ?? config.codex.launcher ?? 'codex',
      timeoutMs: config.timeoutMs,
      writeTimeoutMs: config.writeTimeoutMs,
      model: config.codex.model,
      effort: config.codex.effort,
      profile: config.codex.profile,
      configurationMode: config.codex.configurationMode,
      ignoreRules: config.codex.ignoreRules,
      ignoreUserConfig: config.codex.ignoreUserConfig,
      contextMaxBytes: config.contextCapBytes,
    }),
    claude: createClaudeProvider({
      env: providerEnvironment,
      command: config.claude.executable ?? 'claude',
      timeoutMs: config.timeoutMs,
      writeTimeoutMs: config.writeTimeoutMs,
      model: config.claude.model,
      effort: config.claude.effort,
      profileMode: config.claude.profileMode,
      safeMode: config.claude.safeMode,
      disableChrome: config.claude.noChrome,
      disableSlashCommands: config.claude.disableSlashCommands,
      readAllowedTools: config.claude.readAllowedTools,
      contextMaxBytes: config.contextCapBytes,
    }),
  };
}

export function createRoomApplication(options = {}) {
  return new RoomApplication(options);
}

export class RoomApplication {
  constructor(options = {}) {
    if (!options.workspace) {
      throw new TypeError('createRoomApplication requires a workspace');
    }

    this.options = options;
    this.workspace = normalizeWorkspacePath(options.workspace);
    this.homeDirectory = normalizeWorkspacePath(options.homeDirectory ?? os.homedir());
    this.workspaceComparisonPath = canonicalPathForComparison(this.workspace);
    this.homeDirectoryComparisonPath = canonicalPathForComparison(this.homeDirectory);
    this.resumeRoomId = options.resumeRoomId ?? null;
    this.resumeLabel = null;
    this.emitEvent = options.emitEvent ?? (() => {});
    this.emitStatus = options.emitStatus ?? (() => {});
    this.emitMessage = options.emitMessage ?? (() => {});
    this.now = options.now ?? (() => new Date());
    this.activityDelayMs = options.activityDelayMs ?? 5_000;
    this.setTimer = options.setTimer ?? setTimeout;
    this.clearTimer = options.clearTimer ?? clearTimeout;
    this.providers = options.providers ?? null;
    this.packageVersion = options.packageVersion ?? 'unknown';
    this.packageName = options.packageName ?? '@jaddid911/claudex';
    this.inspectWorkspaceImpl = options.inspectWorkspace ?? inspectWorkspace;
    this.writeDiagnosticsImpl = options.writeDiagnostics ?? writeDiagnosticsBundle;
    this.checkForUpdateImpl = options.checkForUpdate ?? checkForUpdate;
    this.resolveCommandImpl = options.resolveCommand ?? resolveCommand;
    this.memoryCompactionThreshold = options.memoryCompactionThreshold ?? 128;
    this.memoryRecentEventCount = options.memoryRecentEventCount ?? 64;
    this.memoryCompactionBatch = options.memoryCompactionBatch ?? 32;
    this.providerStatus = {};
    this.config = options.config ?? null;
    this.globalConfig = options.config ? structuredClone(options.config) : null;
    this.store = null;
    this.ledger = null;
    this.lease = this.createWriteLease();
    this.active = null;
    this.turnCounter = 0;
    this.contextEvents = [];
    this.roomMemory = null;
    this.projectMemory = null;
    this.memoryError = null;
    this.configSourceInfo = null;
    this.delegationMode = 'auto';
    this.started = false;
    this.closed = false;
  }

  async start() {
    if (this.started) {
      return this.startupSnapshot();
    }

    if (!this.config) {
      const loaded = await loadEffectiveConfig({
        workspace: this.workspace,
        env: this.options.env,
        configPath: this.options.configPath,
        projectConfigPath: this.options.projectConfigPath,
        storageRoot: this.options.storageRoot,
      });
      this.config = loaded.config;
      this.globalConfig = loaded.globalConfig;
      this.configSourceInfo = loaded.sourceInfo;
    } else {
      this.configSourceInfo = {
        defaults: { source: 'defaults' },
        global: { source: 'injected', path: this.options.configPath ?? null, exists: true },
        project: {
          source: 'project',
          path: this.options.projectConfigPath ?? path.join(this.workspace, '.claudex.json'),
          exists: false,
          appliedPaths: [],
          blockedPaths: [],
        },
      };
    }
    if (this.options.persistConfig !== false) {
      this.globalConfig = await saveConfig(this.globalConfig, {
        env: this.options.env,
        configPath: this.options.configPath,
        storageRoot: this.globalConfig.storageRoot,
      });
    }
    this.providers ??= buildDefaultProviders(this.config, this.options.env ?? process.env);
    await this.openInitialStore();
    await this.detectProviders();
    await this.persistRuntimeState();
    await this.replayTranscript();
    try {
      await this.refreshMemory();
    } catch (error) {
      this.memoryError = errorMessage(error);
    }
    this.started = true;
    return this.startupSnapshot();
  }

  startupSnapshot(resumeLabel = null) {
    return {
      roomId: this.store?.room.roomId,
      workspace: this.store?.room.workspacePath ?? this.workspace,
      contextCapBytes: this.config?.contextCapBytes ?? null,
      providers: PROVIDER_NAMES.map((name) => ({
        name,
        status: this.providerStatus[name]?.available ? 'available' : 'unavailable',
        availability: this.ledger?.providers[name]?.availability ?? 'unknown',
        model: this.config?.[name]?.model ?? 'default',
        effort: this.config?.[name]?.effort ?? 'default',
        weight: this.ledger?.providers[name]?.weight ?? this.config?.weights?.[name] ?? 1,
        providerVersion: this.providerStatus[name]?.providerVersion ?? null,
        authStatus: this.providerStatus[name]?.authStatus ?? 'not-verified',
        trustStatus: this.providerStatus[name]?.trustStatus ?? 'unknown',
      })),
      routingMode: this.delegationMode,
      modeProviders: structuredClone(this.config?.modeProviders ?? {}),
      stageProfiles: structuredClone(this.config?.stageProfiles ?? {}),
      modelCatalogConfig: {
        codex: { model: this.config?.codex?.model ?? null },
        claude: { model: this.config?.claude?.model ?? null },
        stageProfiles: structuredClone(this.config?.stageProfiles ?? {}),
      },
      memory: this.memoryStatus(),
      safetyMode: this.isHomeWorkspace()
        ? 'single-writer lease; helpers read-only; home workspace write-protected'
        : 'single-writer lease; helpers read-only',
      resumeLabel: resumeLabel ?? this.resumeLabel,
    };
  }

  isHomeWorkspace() {
    if (process.platform === 'win32') {
      return this.workspaceComparisonPath.toLowerCase() === this.homeDirectoryComparisonPath.toLowerCase();
    }
    return this.workspaceComparisonPath === this.homeDirectoryComparisonPath;
  }

  async openInitialStore() {
    const storeOptions = {
      workspacePath: this.workspace,
      storageRoot: this.config.storageRoot,
      now: isoNow(this.now),
    };
    const requested = this.resumeRoomId;
    this.store = requested
      ? await resumeRoomStore({
          ...storeOptions,
          roomId: requested === 'latest' ? null : requested,
        })
      : null;

    if (requested && requested !== 'latest' && !this.store) {
      throw new Error(`Room ${requested} was not found for this workspace.`);
    }

    if (this.store) {
      this.resumeLabel = `resumed ${this.store.room.roomId}`;
    } else {
      this.store = await createRoomStore(storeOptions);
      this.resumeLabel = requested === 'latest'
        ? `no prior room; started ${this.store.room.roomId}`
        : null;
    }
    this.hydrateRuntimeState();
  }

  hydrateRuntimeState() {
    const state = this.store.getSnapshot().state;
    this.delegationMode = normalizeDelegationMode(state.delegationMode);
    this.ledger = state.capacityLedger?.providers
      ? state.capacityLedger
      : createCapacityLedger({ weights: this.config.weights, createdAt: isoNow(this.now) });
    for (const name of PROVIDER_NAMES) {
      setProviderWeight(this.ledger, name, this.ledger.providers[name]?.weight ?? this.config.weights[name]);
      setProviderBusy(this.ledger, name, false);
      setProviderStickiness(this.ledger, name, {
        workspaceStickiness: this.ledger.providers[name]?.observedTurns > 0 ? 1 : 0,
        sessionStickiness: state.providerSessions?.[name]?.sessionId ? 1 : 0,
      });
    }
    this.turnCounter = maximumTurnCounter(
      this.store.room.roomId,
      Object.keys(state.activeTurns ?? {}),
    );
    this.lease = this.createWriteLease(state.writeLease);
  }

  createWriteLease(initialState = {}) {
    const workspaceLockPath = this.store?.paths?.workspaceRoot
      ? path.join(this.store.paths.workspaceRoot, 'workspace-write.lock')
      : null;
    return new WriteLease(initialState, {
      ...this.options.writeLeaseOptions,
      lockPath: this.options.writeLeaseOptions?.lockPath ??
        workspaceLockPath,
    });
  }

  async detectProviders() {
    await Promise.all(PROVIDER_NAMES.map(async (name) => {
      const provider = this.providers[name];
      if (!provider || typeof provider.detect !== 'function') {
        this.providerStatus[name] = { available: false, reason: 'adapter unavailable' };
        setProviderAvailability(this.ledger, name, 'missing');
        return;
      }

      try {
        const status = await provider.detect();
        this.providerStatus[name] = status;
        setProviderAvailability(this.ledger, name, status.available ? 'available' : 'unavailable');
      } catch (error) {
        this.providerStatus[name] = { available: false, reason: errorMessage(error) };
        setProviderAvailability(this.ledger, name, 'unavailable');
      }
    }));
  }

  async replayTranscript() {
    const replay = await this.store.replayEvents();
    this.turnCounter = Math.max(
      this.turnCounter,
      maximumTurnCounter(this.store.room.roomId, replay.events.map((event) => event.turnId)),
    );
    const transcriptEvents = replay.events.filter(isDurableTranscriptEvent);
    this.contextEvents = transcriptEvents.slice(-MAX_CONTEXT_EVENTS);
    for (const event of transcriptEvents) {
      this.emitEvent(replayDisplayEvent(event));
    }
    if (replay.repaired) {
      await this.appendSystem('Recovered the valid transcript prefix after an incomplete final record.', 'warning');
    }
    await this.emitRecoveryNotices(replay.events);
  }

  async refreshMemory() {
    this.roomMemory = await this.store.loadRoomMemory();
    this.projectMemory = await this.store.loadProjectMemory();

    if ((this.store.state.nextSequence - 1) < this.memoryCompactionThreshold) {
      return;
    }
    const replay = await this.store.replayEvents();
    const retained = Math.max(1, this.memoryRecentEventCount);
    const compactableCount = Math.max(0, replay.events.length - retained);
    if (replay.events.length < this.memoryCompactionThreshold || compactableCount === 0) {
      return;
    }

    const compactableEvents = replay.events.slice(0, compactableCount);
    const sourceThroughSequence = compactableEvents.at(-1)?.sequence ?? 0;
    if ((this.roomMemory?.sourceThroughSequence ?? 0) >= sourceThroughSequence) {
      return;
    }
    if (
      this.roomMemory &&
      sourceThroughSequence - this.roomMemory.sourceThroughSequence < this.memoryCompactionBatch
    ) {
      return;
    }

    const roomMemory = buildRoomMemory({
      room: this.store.room,
      events: compactableEvents,
      now: isoNow(this.now),
    });
    const projectMemory = mergeProjectMemory({
      workspaceHash: this.store.room.workspaceHash,
      roomMemory,
      projectMemory: this.projectMemory,
      now: isoNow(this.now),
    });
    await this.store.saveRoomMemory(roomMemory);
    await this.store.saveProjectMemory(projectMemory);
    this.roomMemory = roomMemory;
    this.projectMemory = projectMemory;
  }

  async emitRecoveryNotices(replayedEvents) {
    const existingTurnNotices = new Set(
      replayedEvents
        .filter((event) => event.metadata?.code === 'recovered-interruption' && event.turnId)
        .map((event) => event.turnId),
    );
    const interruptedTurns = Object.entries(this.store.state.activeTurns ?? {})
      .filter(([, turn]) => turn?.status === 'interrupted');
    const interruptedLease = this.lease.snapshot().lastInterrupted;

    for (const [turnId, turn] of interruptedTurns) {
      if (!turn.interruptionNoticeEmitted && !existingTurnNotices.has(turnId)) {
        const leaseLabel = interruptedLease?.turnId === turnId ? ' Its writer lease was also interrupted.' : '';
        await this.appendEvent({
          actor: 'SYSTEM',
          type: 'warning',
          turnId,
          content: `Recovered interrupted turn ${turnId}.${leaseLabel}`,
          metadata: { code: 'recovered-interruption' },
        });
      }
    }

    if (
      interruptedLease &&
      !interruptedLease.noticeEmitted &&
      !interruptedTurns.some(([turnId]) => turnId === interruptedLease.turnId) &&
      !existingTurnNotices.has(interruptedLease.turnId)
    ) {
      await this.appendEvent({
        actor: 'SYSTEM',
        type: 'warning',
        turnId: interruptedLease.turnId,
        content: `Recovered interrupted writer lease for ${interruptedLease.turnId}.`,
        metadata: { code: 'recovered-interruption' },
      });
    }

    if (interruptedTurns.length > 0 || interruptedLease) {
      await this.store.updateState((state) => {
        for (const [turnId] of interruptedTurns) {
          state.activeTurns[turnId].interruptionNoticeEmitted = true;
        }
      });
      if (this.lease.state.lastInterrupted) {
        this.lease.state.lastInterrupted.noticeEmitted = true;
      }
      await this.persistRuntimeState();
    }
  }

  async dispatch(command) {
    await this.ensureStarted();
    if (this.closed) {
      throw new Error('Room application is closed.');
    }
    const observableWhileBusy = command.kind === 'command' && (
      command.name === 'status' ||
      (command.name === 'model' && !command.provider) ||
      (command.name === 'effort' && !command.provider) ||
      (command.name === 'profile' && !command.stage && !command.provider) ||
      (command.name === 'mode' && !command.mode && !command.lane && !command.provider)
    );
    const awaitingInput = this.isAwaitingInput();
    const clarificationAnswer = awaitingInput && isPlainTextTurn(command);
    const supermodeContext = command.kind === 'command' && command.name === 'context';
    if (awaitingInput && command.kind === 'turn' && !clarificationAnswer) {
      throw new Error('Answer the pending question with plain text, or use /cancel to stop the turn.');
    }
    if (this.isBusy() && !observableWhileBusy && !clarificationAnswer && !supermodeContext) {
      throw new Error('A provider turn is already active. Use /cancel before starting another.');
    }

    if (command.kind === 'turn') {
      if (!command.prompt?.trim()) {
        const commandName = command.supermode ? 'supermode' : command.route;
        await this.appendSystem(`/${commandName} requires a prompt.`, 'warning');
        return;
      }
      if (clarificationAnswer) {
        await this.answerClarification(command.prompt.trim());
        return;
      }
      await this.runTurn(command);
      return;
    }

    if (command.kind !== 'command') {
      return;
    }

    if (command.name === 'context') {
      await this.addSupermodeContext(command.text);
    } else if (command.name === 'status') {
      this.emitStatus(this.getStatus());
    } else if (command.name === 'model') {
      if (command.provider) {
        await this.updateModel(command.provider, command.model);
        if (Object.hasOwn(command, 'effort')) {
          await this.updateEffort(command.provider, command.effort);
        }
      } else {
        this.emitStatus(this.getStatus());
      }
    } else if (command.name === 'effort') {
      if (command.provider) {
        await this.updateEffort(command.provider, command.effort);
      } else {
        this.emitStatus(this.getStatus());
      }
    } else if (command.name === 'profile') {
      if (command.stage && command.provider) {
        await this.updateStageProfile(
          command.stage,
          command.provider,
          command.model,
          command.effort,
        );
      } else {
        this.emitStatus(this.getStatus());
      }
    } else if (command.name === 'mode') {
      if (command.lane && command.provider) {
        await this.updateModeProvider(command.lane, command.provider);
      } else if (command.mode) {
        await this.updateDelegationMode(command.mode);
      } else {
        this.emitStatus(this.getStatus());
      }
    } else if (command.name === 'weight') {
      await this.updateWeight(command.provider, command.value);
    } else if (command.name === 'doctor') {
      await this.runDoctor();
    } else if (command.name === 'changes') {
      await this.showWorkspaceChanges();
    } else if (command.name === 'recover') {
      await this.showRecoveryState();
    } else if (command.name === 'diagnostics') {
      await this.exportDiagnostics();
    } else if (command.name === 'update') {
      await this.showUpdateStatus();
    } else if (command.name === 'memory') {
      await this.showMemoryStatus();
    } else if (command.name === 'project') {
      await this.showProjectConfiguration();
    } else if (command.name === 'new') {
      await this.newRoom();
    } else if (command.name === 'resume') {
      await this.resumeRoom(command.roomId);
    }
  }

  async runTurn(command) {
    const turnId = `${this.store.room.roomId}-turn-${++this.turnCounter}`;
    const controller = new AbortController();
    const execution = this.executeTurn(command, turnId, controller);
    this.active = {
      turnId,
      controller,
      promise: execution,
      providers: new Set(),
      clarifications: null,
      clarificationRound: 0,
      workflow: command.supermode ? 'supermode' : null,
      stage: command.supermode ? 'starting' : null,
      pendingSupermodeContext: [],
    };

    try {
      await execution;
    } finally {
      try {
        await this.refreshMemory();
        this.memoryError = null;
      } catch (error) {
        this.memoryError = errorMessage(error);
      }
      if (this.active?.turnId === turnId) {
        this.active = null;
      }
    }
  }

  async answerClarification(answer) {
    const queue = this.active?.clarifications;
    const current = queue?.items?.[0];
    if (!queue || !current) {
      throw new Error('No provider clarification is waiting for an answer.');
    }

    queue.items.shift();
    queue.answers.set(current.id, answer);
    await this.appendEvent({
      actor: 'YOU',
      type: 'message',
      turnId: this.active.turnId,
      content: answer,
      metadata: {
        code: 'clarification-answer',
        clarificationId: current.id,
        provider: current.provider,
        role: current.role,
        model: current.model,
        effort: current.effort,
      },
    });

    if (queue.items.length === 0) {
      queue.resolve(queue.answers);
    }
  }

  async addSupermodeContext(text) {
    const active = this.active;
    if (
      !active ||
      active.workflow !== 'supermode' ||
      !['starting', 'plan', 'ux', 'code', 'execute', 'review'].includes(active.stage)
    ) {
      throw new Error('No active Supermode stage can accept context. Start one with /supermode <prompt>.');
    }

    const entry = {
      text: String(text ?? '').trim(),
      receivedAtStage: active.stage,
    };
    if (!entry.text) {
      throw new Error('/context requires text for the active Supermode workflow.');
    }

    active.pendingSupermodeContext.push(entry);
    await this.appendEvent({
      actor: 'YOU',
      type: 'message',
      turnId: active.turnId,
      content: entry.text,
      metadata: {
        code: 'supermode-context',
        workflow: 'supermode',
        stage: entry.receivedAtStage,
        route: 'context',
        label: 'context',
      },
    });
  }

  takeSupermodeContext(turnId) {
    if (this.active?.turnId !== turnId || this.active.workflow !== 'supermode') {
      return {};
    }
    const pending = this.active.pendingSupermodeContext;
    if (!Array.isArray(pending) || pending.length === 0) {
      return {};
    }
    this.active.pendingSupermodeContext = [];
    return { supermodeContext: structuredClone(pending) };
  }

  async requestClarificationAnswers(turnId, requests, signal, workflow = null, stage = null) {
    if (!requests.length || signal.aborted) return null;
    if (!this.active || this.active.turnId !== turnId) {
      throw new Error('Cannot request clarification without the active provider turn.');
    }

    const round = ++this.active.clarificationRound;
    const allItems = requests.map((request, index) => {
      const profile = this.resolveAssignmentProfile(request.assignment);
      return {
        id: `${turnId}-clarification-${round}-${index + 1}`,
        provider: request.assignment.provider,
        role: request.role,
        model: profile.model,
        effort: profile.effort,
        question: request.clarification.question,
        options: request.clarification.options,
      };
    });
    let resolveAnswers;
    const answerPromise = new Promise((resolve) => {
      resolveAnswers = resolve;
    });
    const queue = {
      items: structuredClone(allItems),
      answers: new Map(),
      resolve: resolveAnswers,
      ready: false,
    };
    this.active.clarifications = queue;

    const abort = () => queue.resolve(null);
    signal.addEventListener('abort', abort, { once: true });
    await this.markTurn(turnId, {
      status: 'waiting-for-user',
      waitingAt: isoNow(this.now),
      ...(workflow ? { workflow } : {}),
      ...(stage ? { pipelineStage: stage } : {}),
    });
    await this.appendEvent({
      actor: 'SYSTEM',
      type: 'message',
      turnId,
      content: allItems.length === 1
        ? `${actorFor(allItems[0].provider)} needs your answer before continuing.`
        : `${allItems.length} questions queued · ${actorFor(allItems[0].provider)} asks first.`,
      metadata: {
        code: 'waiting-for-user',
        provider: allItems[0].provider,
        providers: allItems.map((item) => item.provider),
        questionCount: allItems.length,
        ...(workflow ? { workflow } : {}),
        ...(stage ? { stage } : {}),
      },
    });
    queue.ready = true;

    try {
      const answers = await answerPromise;
      if (!answers || signal.aborted) return null;
      await this.markTurn(turnId, {
        status: 'running',
        resumedAt: isoNow(this.now),
      });
      await this.appendEvent({
        actor: 'SYSTEM',
        type: 'message',
        turnId,
        content: 'Answer received · resuming the paused provider work.',
        metadata: { code: 'clarification-resumed' },
      });
      return answers;
    } finally {
      signal.removeEventListener('abort', abort);
      if (this.active?.clarifications === queue) {
        this.active.clarifications = null;
      }
    }
  }

  async executeTurn(command, turnId, controller) {
    const prompt = command.prompt.trim();
    const requestedDelegationMode = normalizeDelegationMode(
      command.delegationMode ?? this.delegationMode,
    );
    await this.markTurn(turnId, {
      status: 'running',
      route: command.route,
      delegationMode: requestedDelegationMode,
      leadProvider: null,
      helperProvider: null,
      writerSideEffectsPossible: false,
      startedAt: isoNow(this.now),
    });
    const route = userTurnRoute(command);
    await this.appendEvent({
      actor: 'YOU',
      type: 'message',
      turnId,
      content: prompt,
      metadata: {
        code: 'user-turn',
        route,
        label: route,
        ...(command.supermode ? { workflow: 'supermode' } : {}),
      },
    });
    const roomQuery = detectRoomQuery(prompt);
    if (roomQuery) {
      await this.markTurn(turnId, {
        status: 'completed',
        completedAt: isoNow(this.now),
      });
      await this.appendSystem(this.answerRoomQuery(roomQuery), 'message', turnId);
      return;
    }
    if (command.supermode) {
      await this.executeSupermode(command, prompt, turnId, controller);
      return;
    }
    let plan = createDispatchPlan(
      { ...command, delegationMode: requestedDelegationMode, modeProviders: this.config.modeProviders },
      this.ledger,
      { now: this.now() },
    );

    if (!plan.ok) {
      await this.markTurn(turnId, {
        status: 'failed',
        completedAt: isoNow(this.now),
        error: plan.reason,
      });
      await this.appendSystem(plan.reason, 'warning', turnId);
      return;
    }

    if (plan.requiresWriteLease && this.isHomeWorkspace()) {
      const reason =
        `Write turn blocked because the workspace is your home directory (${this.workspace}). ` +
        'Create or cd into a dedicated project folder, then run claudex there or use claudex --workspace <folder>.';
      await this.markTurn(turnId, {
        status: 'failed',
        completedAt: isoNow(this.now),
        error: reason,
      });
      await this.appendEvent({
        actor: 'SYSTEM',
        type: 'warning',
        turnId,
        content: reason,
        metadata: { code: 'home-workspace-write-blocked' },
      });
      return;
    }

    plan = this.ensureWriterCapability(plan, command.route);
    if (!plan.ok) {
      await this.markTurn(turnId, {
        status: 'failed',
        completedAt: isoNow(this.now),
        error: plan.reason,
      });
      await this.appendSystem(plan.reason, 'warning', turnId);
      return;
    }
    const resolvedDelegationMode = normalizeDelegationMode(
      plan.classification.delegationMode ?? requestedDelegationMode,
    );
    const taskLane = plan.classification.taskLane ?? null;
    const reviewFocus = plan.classification.reviewFocus ?? null;
    const providerObjective = normalizeProviderObjective(prompt, plan.classification);
    plan = {
      ...plan,
      lead: { ...plan.lead, delegationMode: resolvedDelegationMode, taskLane, reviewFocus },
      helper: plan.helper
        ? { ...plan.helper, delegationMode: resolvedDelegationMode, taskLane, reviewFocus }
        : null,
    };

    const taskId = `${turnId}-lead`;
    const helperTaskId = plan.helper ? `${turnId}-helper` : null;
    const intermediateProse = Boolean(plan.helper);
    const sequentialReview = Boolean(plan.helper && plan.requiresWriteLease);
    await this.markTurn(turnId, {
      status: 'running',
      route: command.route,
      delegationMode: resolvedDelegationMode,
      taskLane,
      leadProvider: plan.lead.provider,
      helperProvider: plan.helper?.provider ?? null,
      writerSideEffectsPossible: false,
      startedAt: isoNow(this.now),
    });

    let acquired = null;
    let helperController = null;
    let disposeHelperAbortLink = () => {};
    let helperOutcomePromise = null;
    let helperSettled = false;
    let helperAssignment = plan.helper;
    const usageResults = new Set();
    const collectUsage = (result) => {
      if (result) usageResults.add(result);
      return result;
    };
    try {
      if (plan.requiresWriteLease) {
        const acquisition = this.lease.acquire({
          provider: plan.lead.provider,
          turnId,
          taskId,
          now: this.now(),
        });
        if (!acquisition.ok) {
          throw new Error('The workspace write lease is already held.');
        }
        acquired = acquisition.lease;
        await this.persistRuntimeState();
      }

      await this.appendSystem(this.describePlan(plan), 'message', turnId);
      const leadPromise = this.runAssignment(
        plan.lead,
        providerObjective,
        turnId,
        taskId,
        controller.signal,
        {},
        { intermediate: intermediateProse },
      );
      if (plan.helper && !sequentialReview) {
        const linked = createLinkedAbortController(controller.signal);
        helperController = linked.controller;
        disposeHelperAbortLink = linked.dispose;
        helperOutcomePromise = this.runAssignment(
          helperAssignment,
          providerObjective,
          turnId,
          helperTaskId,
          helperController.signal,
          {},
          { intermediate: intermediateProse },
        ).then(
          (result) => {
            collectUsage(result);
            helperSettled = true;
            return { result, error: null };
          },
          (error) => {
            helperSettled = true;
            return { result: null, error };
          },
        );
      }
      let leadResult = collectUsage(await leadPromise);
      const helperOutcome = helperOutcomePromise ? await helperOutcomePromise : null;
      if (helperOutcome?.error) {
        throw helperOutcome.error;
      }
      let helperResult = helperOutcome?.result ?? null;

      const clarified = await this.resolveClarificationResults(
        [
          {
            assignment: plan.lead,
            result: leadResult,
            taskId,
            role: 'lead',
            intermediate: intermediateProse,
          },
          ...(plan.helper && helperResult ? [{
            assignment: plan.helper,
            result: helperResult,
            taskId: helperTaskId,
            role: 'helper',
            intermediate: intermediateProse,
          }] : []),
        ],
        providerObjective,
        turnId,
        controller.signal,
        { onResult: collectUsage },
      );
      leadResult = clarified[0].result;
      helperResult = clarified[1]?.result ?? null;

      if (this.canSafelyFallback(leadResult)) {
        const fallback = this.createFallbackAssignment(plan);
        if (fallback) {
          await this.appendSystem(
            `${actorFor(plan.lead.provider)} was ${leadResult.status}; retrying once with ${actorFor(fallback.provider)}.`,
            'warning',
            turnId,
          );
          if (acquired && fallback.provider !== acquired.ownerProvider) {
            this.lease.release({
              generation: acquired.generation,
              now: this.now(),
              outcome: 'safe-fallback',
            });
            acquired = null;
            await this.persistRuntimeState();
            if (fallback.mode === 'workspace-write') {
              const fallbackAcquisition = this.lease.acquire({
                provider: fallback.provider,
                turnId,
                taskId: `${turnId}-fallback`,
                now: this.now(),
              });
              if (!fallbackAcquisition.ok) {
                throw new Error('Unable to transfer the workspace write lease for safe fallback.');
              }
              acquired = fallbackAcquisition.lease;
              await this.persistRuntimeState();
            }
          }
          leadResult = collectUsage(await this.runAssignment(
            { ...fallback, delegationMode: resolvedDelegationMode, taskLane, reviewFocus },
            providerObjective,
            turnId,
            `${turnId}-fallback`,
            controller.signal,
            {},
            { intermediate: intermediateProse },
          ));
          plan = {
            ...plan,
            lead: { ...fallback, delegationMode: resolvedDelegationMode, taskLane, reviewFocus },
            helper: null,
          };
          helperResult = null;
        }
      }

      if (
        leadResult.status === TERMINAL_SUCCESS &&
        isClarificationRequest(leadResult.text) &&
        !controller.signal.aborted
      ) {
        const [fallbackClarified] = await this.resolveClarificationResults(
          [{
            assignment: plan.lead,
            result: leadResult,
            taskId: `${turnId}-fallback`,
            role: 'lead',
            intermediate: intermediateProse,
          }],
          providerObjective,
          turnId,
          controller.signal,
          { onResult: collectUsage },
        );
        leadResult = fallbackClarified.result;
      }

      if (
        sequentialReview &&
        plan.helper &&
        leadResult.status === TERMINAL_SUCCESS &&
        !controller.signal.aborted
      ) {
        await this.appendSystem(
          `${actorFor(plan.lead.provider)} implementation complete \u00b7 ` +
            `${actorFor(plan.helper.provider)} reviewing the updated workspace.`,
          'message',
          turnId,
        );
        const linked = createLinkedAbortController(controller.signal);
        helperController = linked.controller;
        disposeHelperAbortLink = linked.dispose;
        helperAssignment = {
          ...plan.helper,
          freshSession: true,
          ...(plan.helper.provider === plan.lead.provider ? { persistSession: false } : {}),
        };
        helperOutcomePromise = this.runAssignment(
          helperAssignment,
          providerObjective,
          turnId,
          helperTaskId,
          helperController.signal,
          {
            leadResult: leadResult.text,
            reviewTarget: 'updated workspace after writer completion',
          },
          { intermediate: true },
        ).then(
          (result) => {
            collectUsage(result);
            helperSettled = true;
            return { result, error: null };
          },
          (error) => {
            helperSettled = true;
            return { result: null, error };
          },
        );
        const sequentialHelperOutcome = await helperOutcomePromise;
        if (sequentialHelperOutcome.error) throw sequentialHelperOutcome.error;
        helperResult = sequentialHelperOutcome.result;
        const [clarifiedHelper] = await this.resolveClarificationResults(
          [{
            assignment: helperAssignment,
            result: helperResult,
            taskId: helperTaskId,
            role: 'helper',
            intermediate: true,
          }],
          providerObjective,
          turnId,
          controller.signal,
          { onResult: collectUsage },
        );
        helperResult = clarifiedHelper.result;
      }

      let finalResult = leadResult;
      let synthesized = false;
      if (
        plan.helper &&
        leadResult.status === TERMINAL_SUCCESS &&
        helperResult?.status === TERMINAL_SUCCESS &&
        !controller.signal.aborted
      ) {
        await this.appendSystem(
          `${actorFor(plan.helper.provider)} review complete \u00b7 ` +
            `${actorFor(plan.lead.provider)} synthesizing the final response.`,
          'message',
          turnId,
        );
        synthesized = true;
        finalResult = collectUsage(await this.runSynthesis(
          plan,
          providerObjective,
          leadResult,
          helperResult,
          turnId,
          `${turnId}-synthesis`,
          controller.signal,
        ));
        if (isClarificationRequest(finalResult.text) && !controller.signal.aborted) {
          const [clarifiedSynthesis] = await this.resolveClarificationResults(
            [{
              assignment: { ...plan.lead, role: 'synthesis' },
              result: finalResult,
              taskId: `${turnId}-synthesis`,
              role: 'synthesis',
              intermediate: false,
            }],
            providerObjective,
            turnId,
            controller.signal,
            { onResult: collectUsage },
          );
          finalResult = clarifiedSynthesis.result;
        }
      }

      if (
        intermediateProse &&
        leadResult.status === TERMINAL_SUCCESS &&
        (!synthesized || finalResult.status !== TERMINAL_SUCCESS) &&
        !controller.signal.aborted
      ) {
        await this.persistProviderResultFallback(
          plan.lead.provider,
          leadResult,
          turnId,
          taskId,
          'lead',
        );
      }

      const status = controller.signal.aborted
        ? 'cancelled'
        : finalResult.status === TERMINAL_SUCCESS
          ? 'completed'
          : 'failed';
      await this.markTurn(turnId, {
        status,
        completedAt: isoNow(this.now),
        writerSideEffectsPossible: Boolean(leadResult.sideEffectsPossible),
      });
      if (status === 'failed') {
        await this.appendSystem(
          `${actorFor(plan.lead.provider)} ended with ${finalResult.status}; uncertain writer side effects were not replayed.`,
          'warning',
          turnId,
        );
      } else if (status === 'cancelled') {
        await this.appendSystem('Turn cancelled; provider processes stopped.', 'warning', turnId);
      } else {
        const responseIncomplete = finalResult.incomplete === true;
        const providerSummary = plan.helper
          ? `${actorFor(plan.lead.provider)} led · ${actorFor(plan.helper.provider)} reviewed`
          : `${actorFor(plan.lead.provider)} completed`;
        const tokenTotal = [...usageResults]
          .reduce((total, result) => total + usageTokens(result.usage), 0);
        await this.appendEvent({
          actor: 'SYSTEM',
          type: 'message',
          turnId,
          content: `${responseIncomplete ? 'Incomplete' : 'Complete'} · ${providerSummary} · ${tokenTotal} turn tokens`,
          metadata: {
            code: 'turn-summary',
            status: responseIncomplete ? 'incomplete' : 'completed',
          },
        });
      }
    } catch (error) {
      await this.markTurn(turnId, {
        status: controller.signal.aborted ? 'cancelled' : 'failed',
        completedAt: isoNow(this.now),
        error: errorMessage(error),
      });
      await this.appendSystem(`Turn failed: ${errorMessage(error)}`, 'warning', turnId);
    } finally {
      disposeHelperAbortLink();
      if (helperController && !helperSettled && !helperController.signal.aborted) {
        helperController.abort(controller.signal.reason ?? 'turn-terminal');
      }
      if (helperOutcomePromise && !helperSettled) {
        await helperOutcomePromise;
      }
      if (acquired) {
        this.lease.release({
          generation: acquired.generation,
          now: this.now(),
          outcome: controller.signal.aborted ? 'cancelled' : 'terminal',
        });
      }
      for (const name of PROVIDER_NAMES) {
        setProviderBusy(this.ledger, name, false);
      }
      await this.persistRuntimeState();
    }
  }

  async executeSupermode(command, prompt, turnId, controller) {
    let pipeline = createSupermodePlan(
      {
        route: 'auto',
        prompt,
        modeProviders: this.config.modeProviders,
      },
      this.ledger,
      { now: this.now() },
    );

    if (!pipeline.ok) {
      await this.markTurn(turnId, {
        status: 'failed',
        workflow: 'supermode',
        completedAt: isoNow(this.now),
        error: pipeline.reason,
      });
      await this.appendSystem(pipeline.reason, 'warning', turnId);
      return;
    }

    pipeline = this.ensureSupermodeWriterCapability(pipeline);
    if (!pipeline.ok) {
      await this.markTurn(turnId, {
        status: 'failed',
        workflow: 'supermode',
        completedAt: isoNow(this.now),
        error: pipeline.reason,
      });
      await this.appendSystem(pipeline.reason, 'warning', turnId);
      return;
    }

    if (pipeline.requiresWriteLease && this.isHomeWorkspace()) {
      const reason =
        `Write turn blocked because the workspace is your home directory (${this.workspace}). ` +
        'Create or cd into a dedicated project folder, then run claudex there or use claudex --workspace <folder>.';
      await this.markTurn(turnId, {
        status: 'failed',
        workflow: 'supermode',
        completedAt: isoNow(this.now),
        error: reason,
      });
      await this.appendEvent({
        actor: 'SYSTEM',
        type: 'warning',
        turnId,
        content: reason,
        metadata: { code: 'home-workspace-write-blocked', workflow: 'supermode' },
      });
      return;
    }

    const taskLane = pipeline.classification.taskLane ?? null;
    const reviewFocus = pipeline.classification.reviewFocus ?? null;
    const providerObjective = normalizeProviderObjective(prompt, pipeline.classification);
    const decorate = (assignment, extra = {}) => ({
      ...assignment,
      delegationMode: 'auto',
      taskLane,
      reviewFocus,
      ...extra,
    });
    pipeline = {
      ...pipeline,
      planner: decorate(pipeline.planner),
      designer: pipeline.designer
        ? decorate(pipeline.designer, { freshSession: true, persistSession: false })
        : null,
      coder: decorate(pipeline.coder),
      executor: decorate(pipeline.executor),
      reviewer: decorate(pipeline.reviewer, {
        freshSession: true,
        persistSession: false,
      }),
    };

    await this.markTurn(turnId, {
      status: 'running',
      workflow: 'supermode',
      pipelineStage: 'plan',
      route: command.route,
      taskLane,
      plannerProvider: pipeline.planner.provider,
      designerProvider: pipeline.designer?.provider ?? null,
      coderProvider: pipeline.coder.provider,
      executorProvider: pipeline.executor.provider,
      reviewerProvider: pipeline.reviewer.provider,
      leadProvider: pipeline.executor.provider,
      helperProvider: pipeline.reviewer.provider,
      writerSideEffectsPossible: false,
    });
    await this.appendEvent({
      actor: 'SYSTEM',
      type: 'message',
      turnId,
      content: this.describeSupermode(pipeline),
      metadata: { code: 'supermode-route', workflow: 'supermode', stage: 'plan' },
    });

    let acquired = null;
    let writerSideEffectsPossible = false;
    try {
      await this.beginSupermodeStage(turnId, 'plan', pipeline.planner);
      let planning = await this.runSupermodeStage(
        pipeline.planner,
        providerObjective,
        turnId,
        `${turnId}-plan`,
        controller.signal,
        {
          pipelineStage: 'plan',
          ...this.takeSupermodeContext(turnId),
        },
      );
      pipeline.planner = planning.assignment;
      let outcome = await this.settleSupermodeStage({
        turnId,
        stage: 'plan',
        assignment: planning.assignment,
        result: planning.result,
        signal: controller.signal,
        writerSideEffectsPossible,
      });
      if (outcome !== 'continue') return;
      if (controller.signal.aborted) throw new Error('Supermode cancelled between stages.');

      const approval = await this.approveSupermodePlan(
        planning,
        providerObjective,
        turnId,
        controller.signal,
        pipeline.designer ? 'ux' : 'code',
      );
      planning = approval.planning;
      pipeline.planner = planning.assignment;
      if (approval.outcome === 'cancelled') return;
      if (approval.outcome !== 'approved') {
        outcome = await this.settleSupermodeStage({
          turnId,
          stage: 'plan',
          assignment: planning.assignment,
          result: planning.result,
          signal: controller.signal,
          writerSideEffectsPossible,
        });
        if (outcome !== 'continue') return;
      }

      let design = null;
      if (pipeline.designer) {
        if (controller.signal.aborted) throw new Error('Supermode cancelled before UX guidance.');
        await this.beginSupermodeStage(turnId, 'ux', pipeline.designer);
        design = await this.runSupermodeStage(
          pipeline.designer,
          providerObjective,
          turnId,
          `${turnId}-ux`,
          controller.signal,
          {
            pipelineStage: 'ux',
            leadResult: planning.result.text,
            ...this.takeSupermodeContext(turnId),
          },
        );
        pipeline.designer = design.assignment;
        outcome = await this.settleSupermodeStage({
          turnId,
          stage: 'ux',
          assignment: design.assignment,
          result: design.result,
          signal: controller.signal,
          writerSideEffectsPossible,
        });
        if (outcome !== 'continue') return;

        const designAdvance = await this.approveSupermodeAdvance({
          assignment: pipeline.designer,
          fromStage: 'ux',
          toStage: 'code',
          turnId,
          signal: controller.signal,
          writerSideEffectsPossible,
        });
        if (designAdvance !== 'approved') return;
      }

      if (pipeline.requiresWriteLease) {
        const acquisition = this.lease.acquire({
          provider: pipeline.coder.provider,
          turnId,
          taskId: `${turnId}-code`,
          now: this.now(),
        });
        if (!acquisition.ok) {
          throw new Error('The workspace write lease is already held.');
        }
        acquired = acquisition.lease;
        await this.persistRuntimeState();
      }

      const transferWriterLease = async (provider, taskId) => {
        if (!acquired || acquired.ownerProvider === provider) return;
        const transferred = this.lease.transfer({
          generation: acquired.generation,
          provider,
          taskId,
          now: this.now(),
        });
        if (!transferred.ok) {
          throw new Error('Unable to transfer the workspace writer lease between Supermode stages.');
        }
        acquired = transferred.lease;
        await this.persistRuntimeState();
      };

      if (controller.signal.aborted) throw new Error('Supermode cancelled before code.');
      await this.beginSupermodeStage(turnId, 'code', pipeline.coder);
      const coding = await this.runSupermodeStage(
        pipeline.coder,
        providerObjective,
        turnId,
        `${turnId}-code`,
        controller.signal,
        {
          pipelineStage: 'code',
          planResult: planning.result.text,
          helperFindings: design?.result?.text ?? '',
          ...this.takeSupermodeContext(turnId),
        },
        (fallback) => transferWriterLease(fallback.provider, `${turnId}-code-fallback`),
      );
      pipeline.coder = coding.assignment;
      writerSideEffectsPossible ||= Boolean(coding.result.sideEffectsPossible);
      outcome = await this.settleSupermodeStage({
        turnId,
        stage: 'code',
        assignment: coding.assignment,
        result: coding.result,
        signal: controller.signal,
        writerSideEffectsPossible,
      });
      if (outcome !== 'continue') return;

      const codeAdvance = await this.approveSupermodeAdvance({
        assignment: pipeline.coder,
        fromStage: 'code',
        toStage: 'execute',
        turnId,
        signal: controller.signal,
        writerSideEffectsPossible,
      });
      if (codeAdvance !== 'approved') return;
      if (controller.signal.aborted) throw new Error('Supermode cancelled before execute.');
      await transferWriterLease(pipeline.executor.provider, `${turnId}-execute`);

      await this.beginSupermodeStage(turnId, 'execute', pipeline.executor);
      const execution = await this.runSupermodeStage(
        pipeline.executor,
        providerObjective,
        turnId,
        `${turnId}-execute`,
        controller.signal,
        {
          pipelineStage: 'execute',
          planResult: planning.result.text,
          leadResult: coding.result.text,
          helperFindings: design?.result?.text ?? '',
          ...this.takeSupermodeContext(turnId),
        },
        (fallback) => transferWriterLease(fallback.provider, `${turnId}-execute-fallback`),
      );
      pipeline.executor = execution.assignment;
      writerSideEffectsPossible ||= Boolean(execution.result.sideEffectsPossible);
      outcome = await this.settleSupermodeStage({
        turnId,
        stage: 'execute',
        assignment: execution.assignment,
        result: execution.result,
        signal: controller.signal,
        writerSideEffectsPossible,
      });
      if (outcome !== 'continue') return;

      const executeAdvance = await this.approveSupermodeAdvance({
        assignment: pipeline.executor,
        fromStage: 'execute',
        toStage: 'review',
        turnId,
        signal: controller.signal,
        writerSideEffectsPossible,
      });
      if (executeAdvance !== 'approved') return;
      if (controller.signal.aborted) throw new Error('Supermode cancelled before review.');

      await this.beginSupermodeStage(turnId, 'review', pipeline.reviewer);
      const review = await this.runSupermodeStage(
        pipeline.reviewer,
        providerObjective,
        turnId,
        `${turnId}-review`,
        controller.signal,
        {
          pipelineStage: 'review',
          planResult: planning.result.text,
          leadResult: execution.result.text,
          helperFindings: [
            coding.result.text,
            design?.result?.text,
          ].filter(Boolean).join('\n\n'),
          ...this.takeSupermodeContext(turnId),
        },
      );
      pipeline.reviewer = review.assignment;
      outcome = await this.settleSupermodeStage({
        turnId,
        stage: 'review',
        assignment: review.assignment,
        result: review.result,
        signal: controller.signal,
        writerSideEffectsPossible,
      });
      if (outcome !== 'continue') return;

      await this.markTurn(turnId, {
        status: 'completed',
        workflow: 'supermode',
        pipelineStage: 'complete',
        completedAt: isoNow(this.now),
        writerSideEffectsPossible,
      });
      this.setActiveWorkflowStage(turnId, 'complete', null);
      const tokenTotal = [planning.result, design?.result, coding.result, execution.result, review.result]
        .reduce((total, result) => total + usageTokens(result?.usage), 0);
      await this.appendEvent({
        actor: 'SYSTEM',
        type: 'message',
        turnId,
        content: `Complete · Supermode · ${actorFor(pipeline.coder.provider)} coded · ` +
          `${actorFor(pipeline.executor.provider)} executed · ` +
          `${actorFor(pipeline.reviewer.provider)} reviewed last · ${tokenTotal} turn tokens`,
        metadata: { code: 'turn-summary', status: 'completed', workflow: 'supermode' },
      });
    } catch (error) {
      const status = controller.signal.aborted ? 'cancelled' : 'failed';
      const activeWriter = Boolean(
        acquired && ['code', 'execute'].includes(this.active?.stage),
      );
      writerSideEffectsPossible ||= activeWriter;
      await this.markTurn(turnId, {
        status,
        workflow: 'supermode',
        completedAt: isoNow(this.now),
        writerSideEffectsPossible,
        error: errorMessage(error),
      });
      await this.appendEvent({
        actor: 'SYSTEM',
        type: 'warning',
        turnId,
        content: status === 'cancelled'
          ? 'Supermode cancelled; provider processes stopped.'
          : `Supermode failed: ${errorMessage(error)}`,
        metadata: { code: `supermode-${status}`, workflow: 'supermode' },
      });
    } finally {
      if (acquired) {
        this.lease.release({
          generation: acquired.generation,
          now: this.now(),
          outcome: controller.signal.aborted ? 'cancelled' : 'terminal',
        });
      }
      for (const name of PROVIDER_NAMES) {
        setProviderBusy(this.ledger, name, false);
      }
      await this.persistRuntimeState();
    }
  }

  async approveSupermodePlan(planning, objective, turnId, signal, nextStage) {
    if (this.options.requirePlanApproval === false) {
      return { outcome: 'approved', planning };
    }

    const nextLabel = SUPERMODE_STAGE_LABELS[nextStage] ?? 'the next stage';
    let current = planning;
    for (let round = 1; round <= MAX_PLAN_APPROVAL_ROUNDS; round += 1) {
      const answers = await this.requestClarificationAnswers(
        turnId,
        [{
          assignment: current.assignment,
          role: 'plan-approval',
          clarification: {
            question: `Plan ready. Continue to ${nextLabel}, or type revision feedback?`,
            options: [`Continue to ${nextLabel}`, 'Cancel Supermode'],
          },
        }],
        signal,
        'supermode',
        'plan',
      );
      if (!answers || signal.aborted) {
        return { outcome: 'cancelled', planning: current };
      }

      const answer = String(answers.values().next().value ?? '').trim();
      if (
        answer.localeCompare(`Continue to ${nextLabel}`, undefined, { sensitivity: 'accent' }) === 0 ||
        /^(?:execute this plan|approve|approved|yes|y|go|proceed|continue|looks good|build it|start)$/iu.test(answer)
      ) {
        await this.appendEvent({
          actor: 'SYSTEM',
          type: 'message',
          turnId,
          content: `Plan approved · continuing to ${nextLabel}.`,
          metadata: { code: 'supermode-plan-approved', workflow: 'supermode', stage: 'plan' },
        });
        return { outcome: 'approved', planning: current };
      }

      if (/^(?:cancel supermode|cancel|no|n|stop|decline)$/iu.test(answer)) {
        await this.markTurn(turnId, {
          status: 'cancelled',
          workflow: 'supermode',
          pipelineStage: 'plan',
          completedAt: isoNow(this.now),
          writerSideEffectsPossible: false,
        });
        await this.appendEvent({
          actor: 'SYSTEM',
          type: 'message',
          turnId,
          content: `Plan declined · Supermode stopped before ${nextLabel}.`,
          metadata: { code: 'supermode-plan-declined', workflow: 'supermode', stage: 'plan' },
        });
        return { outcome: 'cancelled', planning: current };
      }

      await this.beginSupermodeStage(turnId, 'plan', current.assignment);
      current = await this.runSupermodeStage(
        current.assignment,
        [
          'Revise the implementation plan using the user feedback below.',
          `Original objective: ${objective}`,
          `User feedback: ${answer}`,
        ].join('\n\n'),
        turnId,
        `${turnId}-plan-revision-${round}`,
        signal,
        {
          pipelineStage: 'plan',
          planResult: current.result.text,
          planRevisionFeedback: answer,
        },
      );
      if (current.result.status !== TERMINAL_SUCCESS || signal.aborted) {
        return { outcome: 'terminal', planning: current };
      }
    }

    return {
      outcome: 'terminal',
      planning: {
        ...current,
        result: {
          ...current.result,
          status: 'failed',
          error: { message: `Plan approval exceeded ${MAX_PLAN_APPROVAL_ROUNDS} revision rounds.` },
        },
      },
    };
  }

  async approveSupermodeAdvance({
    assignment,
    fromStage,
    toStage,
    turnId,
    signal,
    writerSideEffectsPossible,
  }) {
    const requireStageApproval = this.options.requireStageApproval ??
      this.options.requirePlanApproval !== false;
    if (!requireStageApproval) return 'approved';

    const fromLabel = SUPERMODE_STAGE_LABELS[fromStage] ?? fromStage;
    const toLabel = SUPERMODE_STAGE_LABELS[toStage] ?? toStage;
    const continueAnswer = `Continue to ${toLabel}`;
    const answers = await this.requestClarificationAnswers(
      turnId,
      [{
        assignment,
        role: `${fromStage}-approval`,
        clarification: {
          question: `${fromLabel} complete. Continue to ${toLabel}, or type guidance for it?`,
          options: [continueAnswer, 'Cancel Supermode'],
        },
      }],
      signal,
      'supermode',
      fromStage,
    );
    if (!answers || signal.aborted) return 'cancelled';

    const answer = String(answers.values().next().value ?? '').trim();
    if (/^(?:cancel supermode|cancel|no|n|stop|decline)$/iu.test(answer)) {
      await this.markTurn(turnId, {
        status: 'cancelled',
        workflow: 'supermode',
        pipelineStage: fromStage,
        completedAt: isoNow(this.now),
        writerSideEffectsPossible,
      });
      await this.appendEvent({
        actor: 'SYSTEM',
        type: 'message',
        turnId,
        content: `${fromLabel} accepted · Supermode stopped before ${toLabel}.`,
        metadata: {
          code: 'supermode-stage-declined',
          workflow: 'supermode',
          stage: fromStage,
          nextStage: toStage,
        },
      });
      return 'cancelled';
    }

    const isContinue = answer.localeCompare(
      continueAnswer,
      undefined,
      { sensitivity: 'accent' },
    ) === 0 || /^(?:approve|approved|yes|y|go|proceed|continue|looks good|next)$/iu.test(answer);
    if (!isContinue && answer) {
      this.active?.pendingSupermodeContext.push({
        text: answer,
        receivedAtStage: fromStage,
      });
    }
    await this.appendEvent({
      actor: 'SYSTEM',
      type: 'message',
      turnId,
      content: `${fromLabel} accepted · continuing to ${toLabel}.`,
      metadata: {
        code: 'supermode-stage-approved',
        workflow: 'supermode',
        stage: fromStage,
        nextStage: toStage,
        guidanceAdded: !isContinue,
      },
    });
    return 'approved';
  }

  async runSupermodeStage(
    assignment,
    objective,
    turnId,
    taskId,
    signal,
    handoffExtra = {},
    beforeFallback = null,
  ) {
    let activeAssignment = assignment;
    if (!this.isSupermodeAssignmentEligible(activeAssignment)) {
      const fallback = this.createSupermodeFallbackAssignment(activeAssignment);
      if (!fallback) {
        return {
          assignment: activeAssignment,
          result: {
            provider: activeAssignment.provider,
            access: activeAssignment.mode === 'workspace-write' ? 'write' : 'read',
            status: 'unavailable',
            sessionId: null,
            text: '',
            usage: null,
            sideEffectsPossible: false,
            error: { message: `${actorFor(activeAssignment.provider)} is no longer eligible for ${activeAssignment.label}.` },
            events: [],
            raw: null,
          },
        };
      }
      await this.appendEvent({
        actor: 'SYSTEM',
        type: 'warning',
        turnId,
        content: `${actorFor(activeAssignment.provider)} is unavailable or cooling; ${activeAssignment.label} is using ${actorFor(fallback.provider)}.`,
        metadata: {
          code: 'supermode-eligibility-fallback',
          workflow: 'supermode',
          stage: activeAssignment.label,
        },
      });
      await beforeFallback?.(fallback);
      activeAssignment = fallback;
      await this.updateActiveSupermodeProvider(turnId, activeAssignment);
    }
    let result = await this.runAssignment(
      activeAssignment,
      objective,
      turnId,
      taskId,
      signal,
      handoffExtra,
    );

    if (this.canSafelyFallback(result) && !signal.aborted) {
      const fallback = this.createSupermodeFallbackAssignment(activeAssignment);
      if (fallback) {
        await this.appendEvent({
          actor: 'SYSTEM',
          type: 'warning',
          turnId,
          content: `${actorFor(activeAssignment.provider)} was ${result.status}; ${activeAssignment.label} is retrying once with ${actorFor(fallback.provider)}.`,
          metadata: {
            code: 'supermode-safe-fallback',
            workflow: 'supermode',
            stage: activeAssignment.label,
          },
        });
        await beforeFallback?.(fallback);
        activeAssignment = fallback;
        await this.updateActiveSupermodeProvider(turnId, activeAssignment);
        result = await this.runAssignment(
          activeAssignment,
          objective,
          turnId,
          `${taskId}-fallback`,
          signal,
          handoffExtra,
        );
      }
    }

    const [clarified] = await this.resolveClarificationResults(
      [{
        assignment: activeAssignment,
        result,
        taskId,
        role: activeAssignment.label ?? activeAssignment.role,
        handoffExtra,
      }],
      objective,
      turnId,
      signal,
      { workflow: 'supermode', stage: activeAssignment.label },
    );
    result = clarified.result;

    return { assignment: activeAssignment, result };
  }

  async beginSupermodeStage(turnId, stage, assignment) {
    this.setActiveWorkflowStage(turnId, stage, assignment.provider);
    await this.markTurn(turnId, {
      status: 'running',
      workflow: 'supermode',
      pipelineStage: stage,
      activeProvider: assignment.provider,
      ...this.supermodeProviderPatch(stage, assignment.provider),
      ...(
        ['code', 'execute'].includes(stage) && assignment.mode === 'workspace-write'
          ? { writerSideEffectsPossible: true }
          : {}
      ),
    });
  }

  async updateActiveSupermodeProvider(turnId, assignment) {
    const stage = assignment.label;
    this.setActiveWorkflowStage(turnId, stage, assignment.provider);
    await this.markTurn(turnId, {
      activeProvider: assignment.provider,
      ...this.supermodeProviderPatch(stage, assignment.provider),
    });
  }

  supermodeProviderPatch(stage, provider) {
    if (stage === 'plan') {
      return { plannerProvider: provider };
    }
    if (stage === 'ux') {
      return { designerProvider: provider };
    }
    if (stage === 'code') {
      return { coderProvider: provider, leadProvider: provider };
    }
    if (stage === 'execute') {
      return { executorProvider: provider, leadProvider: provider };
    }
    if (stage === 'review') {
      return { reviewerProvider: provider, helperProvider: provider };
    }
    return {};
  }

  async settleSupermodeStage({
    turnId,
    stage,
    assignment,
    result,
    signal,
    writerSideEffectsPossible,
  }) {
    if (signal.aborted || result.status === 'cancelled') {
      await this.markTurn(turnId, {
        status: 'cancelled',
        workflow: 'supermode',
        pipelineStage: stage,
        completedAt: isoNow(this.now),
        writerSideEffectsPossible,
      });
      await this.appendEvent({
        actor: 'SYSTEM',
        type: 'warning',
        turnId,
        content: `Supermode cancelled during ${stage}; later stages were skipped.`,
        metadata: { code: 'supermode-cancelled', workflow: 'supermode', stage },
      });
      return 'cancelled';
    }

    if (result.status !== TERMINAL_SUCCESS) {
      const failureLead = result.status === 'timeout'
        ? `${stage.toUpperCase()} timed out with ${actorFor(assignment.provider)} at the configured ` +
          `${writerSideEffectsPossible ? 'write ' : ''}deadline`
        : `${stage.toUpperCase()} failed with ${actorFor(assignment.provider)} (${result.status})`;
      const recovery = result.status === 'timeout' && writerSideEffectsPossible
        ? ' Claudex did not retry the writer; inspect the workspace before continuing. ' +
          'Increase writeTimeoutMs in config.json if this stage needs a longer deadline.'
        : '';
      await this.markTurn(turnId, {
        status: 'failed',
        workflow: 'supermode',
        pipelineStage: stage,
        completedAt: isoNow(this.now),
        writerSideEffectsPossible,
        error: result.error?.message ?? result.status,
      });
      await this.appendEvent({
        actor: 'SYSTEM',
        type: 'warning',
        turnId,
        content: `${failureLead}; later stages were skipped${writerSideEffectsPossible ? ' and workspace changes may remain' : ''}.${recovery}`,
        metadata: { code: 'supermode-stage-failed', workflow: 'supermode', stage },
      });
      return 'failed';
    }

    return 'continue';
  }

  setActiveWorkflowStage(turnId, stage, provider) {
    if (this.active?.turnId !== turnId) return;
    this.active.workflow = 'supermode';
    this.active.stage = stage;
    this.active.currentProvider = provider;
  }

  async resolveClarificationResults(entries, objective, turnId, signal, options = {}) {
    let current = entries;

    for (let round = 1; round <= MAX_CLARIFICATION_ROUNDS; round += 1) {
      const requests = current.flatMap((entry) => {
        if (entry.result.status !== TERMINAL_SUCCESS) return [];
        const clarification = parseClarificationRequest(entry.result.text);
        return clarification ? [{ entry, clarification }] : [];
      });
      if (requests.length === 0 || signal.aborted) return current;

      const answers = await this.requestClarificationAnswers(
        turnId,
        requests.map(({ entry, clarification }) => ({
          assignment: entry.assignment,
          role: entry.role,
          clarification,
        })),
        signal,
        options.workflow ?? null,
        options.stage ?? null,
      );
      if (!answers || signal.aborted) return current;

      current = await Promise.all(current.map(async (entry) => {
        const requestIndex = requests.findIndex((request) => request.entry === entry);
        if (requestIndex < 0) return entry;
        const request = requests[requestIndex];
        const clarificationId = `${turnId}-clarification-${this.active?.clarificationRound}-${requestIndex + 1}`;
        const answer = answers.get(clarificationId);
        const continuationObjective = [
          'Continue the original objective from the paused provider session.',
          `Original objective: ${objective}`,
          `Clarification question: ${request.clarification.question}`,
          `User answer: ${answer}`,
        ].join('\n\n');
        const result = await this.runAssignment(
          entry.assignment,
          continuationObjective,
          turnId,
          `${entry.taskId}-clarification-${round}`,
          signal,
          {
            ...(entry.handoffExtra ?? {}),
            clarificationQuestion: request.clarification.question,
            clarificationAnswer: answer,
            clarificationProvider: entry.assignment.provider,
            priorProviderResult: entry.result.text,
          },
          {
            sessionIdOverride: entry.result.sessionId ?? null,
            intermediate: entry.intermediate === true,
          },
        );
        options.onResult?.(result);
        return { ...entry, result };
      }));
    }

    return current.map((entry) => {
      if (!parseClarificationRequest(entry.result.text)) return entry;
      return {
        ...entry,
        result: {
          ...entry.result,
          status: 'failed',
          error: { message: `Provider exceeded the ${MAX_CLARIFICATION_ROUNDS}-round clarification limit.` },
        },
      };
    });
  }

  async runAssignment(
    assignment,
    objective,
    turnId,
    taskId,
    signal,
    handoffExtra = {},
    runOptions = {},
  ) {
    const provider = this.providers[assignment.provider];
    const access = assignment.mode === 'workspace-write' ? 'write' : 'read';
    const context = await this.contextPacket(objective, assignment.role, {
      ...handoffExtra,
      taskId,
      turnId,
      access,
      delegationMode: assignment.delegationMode ?? this.delegationMode,
      taskLane: assignment.taskLane ?? null,
      reviewFocus: assignment.reviewFocus ?? null,
      profileStage: assignment.profileStage ?? null,
    });
    if (contextTruncationNeedsWarning(context)) {
      await this.appendSystem(
        `${actorFor(assignment.provider)} context was truncated to the configured byte limit.`,
        'warning',
        turnId,
      );
    }
    const prompt = assignment.mode === 'workspace-write'
      ? writeAssignmentPrompt(assignment, objective)
      : readOnlyAssignmentPrompt(assignment, objective);
    const sessionId = runOptions.sessionIdOverride !== undefined
      ? runOptions.sessionIdOverride
      : assignment.freshSession
        ? null
        : this.sessionFor(assignment.provider, access);
    const label = assignment.label ?? (
      assignment.role.includes('lead') || assignment.role === 'direct-turn'
        ? 'lead'
        : 'helper'
    );
    const activity = this.createActivityWatch(assignment.provider, label);

    setProviderBusy(this.ledger, assignment.provider, true);
    this.active?.providers.add(assignment.provider);
    let eventQueue = Promise.resolve();
    let sawVisibleProviderText = false;
    const onEvent = (event) => {
      activity.pulse();
      if (
        (event?.type === 'text.delta' || event?.type === 'text.message') &&
        String(event?.text ?? '').trim()
      ) {
        sawVisibleProviderText = true;
      }
      eventQueue = eventQueue.then(() => this.appendProviderEvent(
        assignment.provider,
        event,
        turnId,
        taskId,
        label,
        { intermediate: runOptions.intermediate === true },
      ));
    };

    let result;
    const profile = this.resolveAssignmentProfile(assignment);
    try {
      result = await provider.runTurn({
        prompt,
        workspace: this.workspace,
        access,
        sessionId,
        signal,
        onEvent,
        context: context.packet,
        modelOverride: profile.model,
        effortOverride: profile.effort,
      });
    } catch (error) {
      result = {
        provider: assignment.provider,
        access,
        status: signal.aborted ? 'cancelled' : 'failed',
        sessionId,
        text: '',
        usage: null,
        sideEffectsPossible: access === 'write',
        error: { message: errorMessage(error) },
        events: [],
      };
    }
    try {
      await eventQueue;
    } finally {
      activity.stop();
    }
    await this.persistProviderResult(
      assignment.provider,
      result,
      turnId,
      taskId,
      label,
      {
        emit: runOptions.intermediate !== true && !sawVisibleProviderText,
        ttyFallback:
          runOptions.intermediate !== true && sawVisibleProviderText && label === 'helper',
        intermediate: runOptions.intermediate === true,
      },
    );
    await this.recordResult(assignment, result);
    return result;
  }

  async runSynthesis(
    plan,
    objective,
    leadResult,
    helperResult,
    turnId,
    taskId,
    signal,
    options = {},
  ) {
    const assignment = plan.lead;
    const access = assignment.mode === 'workspace-write' ? 'write' : 'read';
    const { sessionIdOverride, ...contextOptions } = options;
    const context = await this.contextPacket(objective, 'synthesis', {
      ...contextOptions,
      taskId,
      turnId,
      leadResult: leadResult.text,
      helperFindings: helperResult.text,
      access,
      delegationMode: plan.classification.delegationMode ?? this.delegationMode,
      taskLane: plan.classification.taskLane ?? null,
      reviewFocus: plan.classification.reviewFocus ?? null,
      profileStage: assignment.profileStage ?? null,
    });
    if (contextTruncationNeedsWarning(context)) {
      await this.appendSystem('The synthesis context was truncated to the configured byte limit.', 'warning', turnId);
    }
    let completionInstruction = 'Remain read-only and report the combined conclusion.';
    if (access === 'write') {
      completionInstruction = options.workflow === 'supermode'
        ? 'Re-check the workspace, address concrete review findings, run focused verification, and disclose any post-review edits.'
        : 'Re-check the workspace and complete or verify the requested changes.';
    }
    const prompt = [
      options.workflow === 'supermode'
        ? 'Synthesize the execute result and independent review into the final response.'
        : 'Synthesize the lead result and helper findings into the final verified response.',
      completionInstruction,
    ].join('\n\n');
    const provider = this.providers[assignment.provider];
    const activity = this.createActivityWatch(assignment.provider, 'synthesis');
    let eventQueue = Promise.resolve();
    let sawVisibleProviderText = false;
    const onEvent = (event) => {
      activity.pulse();
      if (
        (event?.type === 'text.delta' || event?.type === 'text.message') &&
        String(event?.text ?? '').trim()
      ) {
        sawVisibleProviderText = true;
      }
      eventQueue = eventQueue.then(() => this.appendProviderEvent(
        assignment.provider,
        event,
        turnId,
        taskId,
        'synthesis',
      ));
    };

    let result;
    const profile = this.resolveAssignmentProfile(assignment);
    try {
      if (assignment.provider === 'codex' && access === 'write' && provider.runSynthesisTurn) {
        result = await provider.runSynthesisTurn({
          prompt,
          workspace: this.workspace,
          signal,
          onEvent,
          context: context.packet,
          modelOverride: profile.model,
          effortOverride: profile.effort,
        });
      } else {
        result = await provider.runTurn({
          prompt,
          workspace: this.workspace,
          access,
          sessionId: sessionIdOverride !== undefined
            ? sessionIdOverride
            : this.sessionFor(assignment.provider, access),
          signal,
          onEvent,
          context: context.packet,
          modelOverride: profile.model,
          effortOverride: profile.effort,
        });
      }
    } catch (error) {
      result = {
        provider: assignment.provider,
        access,
        status: signal.aborted ? 'cancelled' : 'failed',
        sessionId: null,
        text: '',
        usage: null,
        sideEffectsPossible: access === 'write',
        error: { message: errorMessage(error) },
        events: [],
      };
    }
    try {
      await eventQueue;
    } finally {
      activity.stop();
    }
    await this.persistProviderResult(
      assignment.provider,
      result,
      turnId,
      taskId,
      'synthesis',
      { emit: !sawVisibleProviderText },
    );
    await this.recordResult({ ...assignment, role: 'synthesis' }, result);
    return result;
  }

  async recordResult(assignment, result) {
    const provider = assignment.provider;
    const role = assignment.role === 'synthesis'
      ? 'lead'
      : assignment.role.includes('lead') || assignment.role === 'direct-turn'
        ? 'lead'
        : 'helper';
    recordProviderTurn(this.ledger, provider, {
      role,
      tokens: usageTokens(result.usage),
      at: isoNow(this.now),
    });
    if (result.status === TERMINAL_SUCCESS) {
      recordProviderSuccess(this.ledger, provider);
    } else if (result.status !== 'cancelled') {
      recordProviderFailure(this.ledger, provider, {
        kind: failureKind(result),
        now: this.now(),
      });
    }
    if (assignment.persistSession !== false) {
      if (result.sessionInvalidated) {
        await this.store.updateState((state) => {
          delete state.providerSessions[provider];
        });
      }
      if (result.sessionId && (!result.sessionInvalidated || result.status === TERMINAL_SUCCESS)) {
        await this.store.updateState((state) => {
          state.providerSessions[provider] = {
            sessionId: result.sessionId,
            access: result.access,
            updatedAt: isoNow(this.now),
          };
        });
      }
    }
    setProviderStickiness(this.ledger, provider, {
      workspaceStickiness: 1,
      sessionStickiness: result.sessionId || this.store.state.providerSessions?.[provider]?.sessionId ? 1 : 0,
    });
    setProviderBusy(this.ledger, provider, false);
    await this.persistRuntimeState();
  }

  sessionFor(provider, access) {
    const session = this.store.state.providerSessions?.[provider];
    if (!session || session.access !== access) {
      return null;
    }
    if (provider === 'codex' && access === 'write') {
      return null;
    }
    return session.sessionId ?? null;
  }

  async contextPacket(objective, role, extra = {}) {
    const { turnId, ...packetExtra } = extra;
    const memoryWatermark = this.roomMemory?.sourceThroughSequence ?? 0;
    const contextTranscript = this.contextEvents.filter((event) => (
      event.sequence > memoryWatermark && (!turnId || event.turnId !== turnId)
    ));
    const roomRoster = PROVIDER_NAMES.map((name) => ({
      name,
      availability: this.providerStatus[name]?.available ? 'available' : 'unavailable',
      authStatus: this.providerStatus[name]?.authStatus ?? 'not-verified',
      sessionPresent: Boolean(this.store.state.providerSessions?.[name]?.sessionId),
      model: this.config[name].model ?? 'default',
      effort: this.config[name].effort ?? 'default',
    }));
    return buildContextPacket({
      workspace: this.workspace,
      objective,
      role,
      dispatchSequence: this.store.state.nextSequence,
      transcript: contextTranscript,
      safetyConstraints: [
        packetExtra.access === 'write'
          ? 'This provider holds the only workspace-write lease.'
          : 'This provider is read-only and must not modify the workspace.',
        'Do not start recursive delegation.',
      ],
      extra: {
        ...packetExtra,
        ...(this.projectMemory ? { projectMemory: this.projectMemory } : {}),
        ...(this.roomMemory?.resumeBrief
          ? { roomMemory: { resumeBrief: this.roomMemory.resumeBrief } }
          : {}),
        roomRoster,
        delegationMode: packetExtra.delegationMode ?? this.delegationMode,
        roomBehavior: 'Providers are invoked per turn and receive a bounded sanitized shared transcript. They do not receive the other provider\'s private reasoning or hidden session state. A provider may continue its own official CLI session when resumed.',
      },
      capBytes: this.config.contextCapBytes,
    });
  }

  answerRoomQuery(query) {
    if (query.type === 'shared-context') {
      return 'Codex and Claude receive a bounded shared transcript of sanitized room events when each is invoked. ' +
        'They do not receive the other provider\'s private reasoning, hidden session state, or a live feed. ' +
        'A provider may continue its own official CLI session when resumed; older room events may be omitted when the context limit is reached.';
    }

    if (query.type === 'provider-presence' && query.provider) {
      const available = this.providerStatus[query.provider]?.available === true;
      return `${actorFor(query.provider)} is ${available ? 'available' : 'unavailable'} for routing in this room. ` +
        'Providers are invoked per turn, not continuously active in every transcript. ' +
        `Use /${query.provider} <prompt> to force that provider or /both <prompt> to invoke both.`;
    }

    const roster = PROVIDER_NAMES.map((name) =>
      `${actorFor(name)}:${this.providerStatus[name]?.available ? 'available' : 'unavailable'}`,
    ).join(', ');
    return `Providers in this room: ${roster}. Providers are invoked per turn, not continuously active in every transcript. Use /codex <prompt>, /claude <prompt>, or /both <prompt> to direct routing.`;
  }

  async inspectCurrentWorkspace() {
    const configuredGit = this.options.gitExecutable ?? null;
    const resolved = configuredGit
      ? { command: configuredGit, argsPrefix: [] }
      : await this.resolveCommandImpl({
          command: 'git',
          cwd: this.workspace,
          env: createProviderEnvironment(
            this.options.env ?? process.env,
            this.config.environmentPassThrough,
          ),
        });
    if (resolved.argsPrefix?.length) {
      throw new Error('The resolved Git command is not a direct executable.');
    }
    return this.inspectWorkspaceImpl({
      workspacePath: this.workspace,
      gitExecutable: resolved.command,
    });
  }

  async safeWorkspaceInspection() {
    try {
      return { inspection: await this.inspectCurrentWorkspace(), error: null };
    } catch (error) {
      return { inspection: null, error: errorMessage(error) };
    }
  }

  async runDoctor() {
    const { inspection, error } = await this.safeWorkspaceInspection();
    const lines = [
      `Doctor · Claudex ${this.packageVersion} · Node ${process.version}`,
      ...PROVIDER_NAMES.map((name) => {
        const provider = this.providerStatus[name] ?? {};
        const capabilities = [
          provider.canRead === false ? 'read unavailable' : 'read ready',
          provider.canWrite === false ? 'write unavailable' : 'write ready',
          provider.supportsResume === false ? 'resume unavailable' : 'resume ready',
        ].join(' · ');
        return `${actorFor(name)} · ${provider.available ? 'available' : 'unavailable'} · ` +
          `CLI ${provider.providerVersion ?? 'unknown'} · auth ${provider.authStatus ?? 'not-verified'} · ` +
          `trust ${provider.trustStatus ?? 'unknown'} · ${capabilities}`;
      }),
      inspection
        ? `Workspace · ${formatWorkspaceSummary(inspection)}`
        : `Workspace check unavailable · ${error}`,
      `Configuration · ${this.configSourceInfo?.project?.exists ? 'global + project' : 'global'} · ` +
        `shared context ${formatByteCount(this.config.contextCapBytes)}`,
      'Next · fix any unavailable provider or trust warning, then run /status for live routing details.',
    ];
    await this.appendEvent({
      actor: 'SYSTEM',
      type: 'message',
      content: lines.join('\n'),
      metadata: { code: 'doctor-report' },
    });
  }

  async showWorkspaceChanges() {
    const { inspection, error } = await this.safeWorkspaceInspection();
    if (!inspection) {
      await this.appendSystem(`Workspace changes unavailable · ${error}`, 'warning');
      return;
    }
    const lines = [`Changes · ${formatWorkspaceSummary(inspection)}`];
    for (const entry of inspection.entries ?? []) {
      lines.push(`${entry.status} · ${entry.previousPath ? `${entry.previousPath} → ` : ''}${entry.path}`);
    }
    if (inspection.truncated) {
      lines.push(`… ${inspection.omittedCount} more path(s) omitted`);
    }
    await this.appendEvent({
      actor: 'SYSTEM',
      type: 'message',
      content: lines.join('\n'),
      metadata: { code: 'changes-report' },
    });
  }

  async showRecoveryState() {
    const turns = Object.entries(this.store.state.activeTurns ?? {});
    const candidate = turns
      .filter(([, turn]) => ['failed', 'interrupted', 'cancelled'].includes(turn?.status))
      .at(-1);
    const { inspection, error } = await this.safeWorkspaceInspection();
    const lines = candidate
      ? [
          `Recovery · ${candidate[0]} · ${candidate[1].status}`,
          candidate[1].writerSideEffectsPossible
            ? 'Workspace changes may remain; Claudex will not replay this writer automatically.'
            : 'No possible writer side effects were recorded for this turn.',
        ]
      : ['Recovery · no failed, interrupted, or cancelled turn is recorded in this room.'];
    lines.push(inspection
      ? `Workspace · ${formatWorkspaceSummary(inspection)}`
      : `Workspace check unavailable · ${error}`);
    lines.push('Next · inspect /changes before retrying or reverting anything.');
    await this.appendEvent({
      actor: 'SYSTEM',
      type: 'message',
      content: lines.join('\n'),
      metadata: { code: 'recovery-report' },
    });
  }

  async exportDiagnostics() {
    const stamp = isoNow(this.now).replace(/[:.]/gu, '-');
    const outputPath = path.join(this.store.paths.roomPath, `diagnostics-${stamp}.json`);
    const providerVersions = Object.fromEntries(PROVIDER_NAMES.map((name) => [name, {
      version: this.providerStatus[name]?.providerVersion ?? null,
      status: this.providerStatus[name]?.available ? 'available' : 'unavailable',
      capabilities: this.providerStatus[name]?.capabilities ?? {},
    }]));
    const result = await this.writeDiagnosticsImpl({
      outputPath,
      workspacePath: this.workspace,
      workspaceHash: this.store.room.workspaceHash,
      homePath: this.homeDirectory,
      generatedAt: isoNow(this.now),
      packageName: this.packageName,
      packageVersion: this.packageVersion,
      room: this.store.room,
      state: this.store.state,
      status: this.getStatus(),
      providerVersions,
      config: this.config,
      recentEvents: this.contextEvents,
    });
    await this.appendEvent({
      actor: 'SYSTEM',
      type: 'message',
      content: `Diagnostics exported · ${formatPrivateStatePath(result.outputPath, this.store.paths.storageRoot)} · ${formatByteCount(result.bytes)}`,
      metadata: { code: 'diagnostics-export' },
    });
  }

  async showUpdateStatus() {
    let result;
    try {
      result = await this.checkForUpdateImpl({
        packageName: this.packageName,
        currentVersion: this.packageVersion,
      });
    } catch (error) {
      result = { status: 'offline', reason: errorMessage(error), updateAvailable: false };
    }
    let content;
    if (result.status !== 'ok') {
      content = `Update check unavailable · ${result.reason ?? result.status} · no installation was attempted.`;
    } else if (result.updateAvailable) {
      content = `Update available · ${result.current} → ${result.latest}\nRun: ${result.installCommand}`;
    } else {
      content = `Claudex ${result.current} is current · no installation was attempted.`;
    }
    await this.appendEvent({
      actor: 'SYSTEM',
      type: 'message',
      content,
      metadata: { code: 'update-status', updateAvailable: result.updateAvailable },
    });
  }

  async showMemoryStatus() {
    const status = this.memoryStatus();
    const lines = [
      ...(status.error ? [`Memory warning · ${status.error}`] : []),
      status.room
        ? `Room memory · through event ${status.room.sourceThroughSequence} · updated ${status.room.updatedAt}`
        : 'Room memory · not needed yet; recent durable context still fits.',
      status.project
        ? `Project memory · last room ${status.project.lastRoomId} · updated ${status.project.updatedAt}`
        : 'Project memory · no compacted project history yet.',
      `Recent durable events retained · ${status.retainedTranscriptEvents}`,
      'Raw sanitized events remain the source of truth; memory only replaces older handoff context.',
    ];
    await this.appendEvent({
      actor: 'SYSTEM',
      type: 'message',
      content: lines.join('\n'),
      metadata: { code: 'memory-status' },
    });
  }

  async showProjectConfiguration() {
    const project = this.configSourceInfo?.project;
    const lines = project?.exists
      ? [
          `Project profile · ${project.path}`,
          `Applied · ${(project.appliedPaths ?? []).join(', ') || 'none'}`,
          `Blocked · ${(project.blockedPaths ?? []).join(', ') || 'none'}`,
        ]
      : [
          `Project profile · none (${project?.path ?? path.join(this.workspace, '.claudex.json')})`,
          'Create .claudex.json to pin safe model, effort, weight, and stage-routing preferences for this repository.',
        ];
    await this.appendEvent({
      actor: 'SYSTEM',
      type: 'message',
      content: lines.join('\n'),
      metadata: { code: 'project-profile' },
    });
  }

  async appendProviderEvent(provider, normalizedEvent, turnId, taskId, label, options = {}) {
    if (
      normalizedEvent?.type === 'activity' &&
      String(normalizedEvent?.status ?? '').startsWith('rate_limit_')
    ) {
      const info = normalizedEvent.info ?? {};
      recordProviderUsageLimit(this.ledger, provider, {
        status: info.status ?? normalizedEvent.status.replace('rate_limit_', ''),
        scope: info.scope ?? info.rate_limit_type ?? info.rateLimitType ?? null,
        resetsAt: info.resets_at ?? info.reset_at ?? info.resetsAt ?? info.resetAt ?? null,
        retryAfterSeconds: Number(
          info.retry_after_seconds ?? info.retryAfterSeconds ?? Number.NaN,
        ),
        reportedAt: isoNow(this.now),
      });
    }
    const mapped = providerEventToCanonical(
      provider,
      normalizedEvent,
      turnId,
      taskId,
      label,
      options,
    );
    if (mapped.input.type !== 'warning') {
      this.emitEvent(replayDisplayEvent(mapped.input));
      return mapped.input;
    }
    const event = await this.store.appendEvent(mapped.input, { timestamp: isoNow(this.now) });
    this.rememberEvent(event);
    this.emitEvent(replayDisplayEvent(event));
    return event;
  }

  async persistProviderResult(provider, result, turnId, taskId, label, options = {}) {
    const content = String(result?.text ?? '').trim();
    if (!content) return null;
    const event = await this.store.appendEvent({
      actor: actorFor(provider),
      type: 'message',
      turnId,
      taskId,
      content,
      metadata: {
        code: 'provider-result-snapshot',
        label,
        providerEventType: 'result.snapshot',
        status: result?.status ?? null,
        ...(result?.incomplete ? {
          incomplete: true,
          stopReason: result.stopReason ?? null,
        } : {}),
        ...(options.ttyFallback ? { ttyFallback: true } : {}),
        ...(options.intermediate ? { intermediate: true } : {}),
      },
    }, { timestamp: isoNow(this.now) });
    this.rememberEvent(event);
    if (options.emit || options.ttyFallback) {
      this.emitEvent(replayDisplayEvent(event));
    }
    return event;
  }

  async persistProviderResultFallback(provider, result, turnId, taskId, label) {
    const content = String(result?.text ?? '').trim();
    if (!content) return;
    const event = await this.store.appendEvent({
      actor: actorFor(provider),
      type: 'message',
      turnId,
      taskId,
      content,
      label,
      metadata: {
        code: 'provider-result-fallback',
        label,
        providerEventType: 'result.snapshot',
        status: result?.status ?? null,
        intermediate: true,
        ttyFallback: true,
      },
    }, { timestamp: isoNow(this.now) });
    this.rememberEvent(event);
    this.emitEvent(replayDisplayEvent(event));
  }

  createActivityWatch(provider, label) {
    let timer = null;
    const schedule = () => {
      if (!Number.isFinite(this.activityDelayMs) || this.activityDelayMs <= 0) return;
      if (timer) this.clearTimer(timer);
      timer = this.setTimer(() => {
        timer = null;
        this.emitEvent({
          actor: actorFor(provider),
          type: 'activity',
          label,
          text: `Waiting for ${actorFor(provider)} output...`,
        });
      }, this.activityDelayMs);
      timer?.unref?.();
    };

    this.emitEvent({
      actor: actorFor(provider),
      type: 'activity',
      label,
      text: 'Working...',
    });
    schedule();
    return {
      pulse: schedule,
      stop: () => {
        if (timer) this.clearTimer(timer);
        timer = null;
        this.emitEvent({
          actor: actorFor(provider),
          type: 'activity.finish',
          label,
        });
      },
    };
  }

  async appendEvent(input) {
    const event = await this.store.appendEvent(input, { timestamp: isoNow(this.now) });
    this.rememberEvent(event);
    this.emitEvent(replayDisplayEvent(event));
    return event;
  }

  rememberEvent(event) {
    if (!isDurableTranscriptEvent(event)) return;
    this.contextEvents.push(event);
    if (this.contextEvents.length > MAX_CONTEXT_EVENTS) {
      this.contextEvents.splice(0, this.contextEvents.length - MAX_CONTEXT_EVENTS);
    }
  }

  async appendSystem(content, type = 'message', turnId = null) {
    return this.appendEvent({ actor: 'SYSTEM', type, turnId, content });
  }

  describePlan(plan) {
    const mode = plan.classification.taskLane ?? plan.classification.delegationMode ?? 'auto';
    const leadAction = roleAction(plan.lead.role, plan.requiresWriteLease ? 'writes' : 'leads');
    const lead = `${actorFor(plan.lead.provider)} ${leadAction}`;
    if (!plan.helper) return `${mode} · ${lead}`;
    const helperAction = roleAction(plan.helper.role, 'reviews');
    return `${mode} · ${lead} · ${actorFor(plan.helper.provider)} ${helperAction}`;
  }

  describeSupermode(pipeline) {
    const stages = [
      `supermode · ${actorFor(pipeline.planner.provider)} plans`,
    ];
    if (pipeline.designer) {
      stages.push(`${actorFor(pipeline.designer.provider)} guides UI`);
    }
    stages.push(
      `${actorFor(pipeline.coder.provider)} ${pipeline.requiresWriteLease ? 'codes' : 'checks code'}`,
      `${actorFor(pipeline.executor.provider)} ${pipeline.requiresWriteLease ? 'executes' : 'validates'}`,
      `${actorFor(pipeline.reviewer.provider)} reviews last`,
    );
    return stages.join(' → ');
  }

  ensureSupermodeWriterCapability(pipeline) {
    if (!pipeline.requiresWriteLease) return pipeline;

    const next = { ...pipeline };
    for (const key of ['coder', 'executor']) {
      const assignment = next[key];
      if (this.providerStatus[assignment.provider]?.canWrite !== false) continue;
      const fallback = this.createSupermodeFallbackAssignment(assignment);
      if (!fallback) {
        return {
          ok: false,
          reason: `${actorFor(assignment.provider)} writer mode is unavailable; ` +
            `no write-capable Supermode ${assignment.label} provider was started.`,
        };
      }

      const previousProvider = assignment.provider;
      const previousCanRead = this.providerStatus[previousProvider]?.canRead !== false;
      next[key] = fallback;
      for (const [readKey, stage] of [
        ['planner', 'plan'],
        ['designer', 'ux'],
        ['reviewer', 'review'],
      ]) {
        const readAssignment = next[readKey];
        const automatic = normalizeModeProvider(this.config.modeProviders?.[stage], 'auto') === 'auto';
        if (
          readAssignment &&
          previousCanRead &&
          automatic &&
          readAssignment.provider === fallback.provider
        ) {
          next[readKey] = { ...readAssignment, provider: previousProvider };
        }
      }
    }
    return next;
  }

  ensureWriterCapability(plan, route) {
    if (!plan.requiresWriteLease || this.providerStatus[plan.lead.provider]?.canWrite !== false) {
      return plan;
    }

    const helperCanWrite = plan.helper && this.providerStatus[plan.helper.provider]?.canWrite !== false;
    if ((route === 'auto' || route === 'both') && helperCanWrite) {
      const assignments = assignComplementaryRoles(
        plan.classification,
        plan.helper.provider,
        plan.lead.provider,
      );
      return {
        ...plan,
        lead: assignments.lead,
        helper: assignments.helper,
        requiresWriteLease: true,
      };
    }

    return {
      ok: false,
      reason: `${actorFor(plan.lead.provider)} writer mode is unavailable; no write-capable fallback was started.`,
    };
  }

  canSafelyFallback(result) {
    return (
      !result?.sideEffectsPossible &&
      (result?.status === 'capacity' || result?.status === 'unavailable')
    );
  }

  createFallbackAssignment(plan) {
    const candidate = plan.helper?.provider ?? PROVIDER_NAMES.find((name) => name !== plan.lead.provider);
    if (!candidate || this.providerStatus[candidate]?.available === false) {
      return null;
    }
    const assignments = assignComplementaryRoles(plan.classification, candidate, null);
    if (
      assignments.lead.mode === 'workspace-write' &&
      this.providerStatus[candidate]?.canWrite === false
    ) {
      return null;
    }
    return assignments.lead;
  }

  createSupermodeFallbackAssignment(assignment) {
    const snapshot = getCapacitySnapshot(this.ledger, { now: this.now() });
    const candidate = PROVIDER_NAMES.find((name) => {
      if (name === assignment.provider) return false;
      const capacity = snapshot.providers[name];
      const capability = this.providerStatus[name];
      if (!capacity?.available || capacity.busy || capacity.inCooldown) return false;
      if (capability?.available === false || capability?.canRead === false) return false;
      if (assignment.mode === 'workspace-write' && capability?.canWrite === false) return false;
      return true;
    });
    return candidate ? { ...assignment, provider: candidate } : null;
  }

  isSupermodeAssignmentEligible(assignment) {
    const snapshot = getCapacitySnapshot(this.ledger, { now: this.now() });
    const capacity = snapshot.providers[assignment.provider];
    const capability = this.providerStatus[assignment.provider];
    if (!capacity?.available || capacity.busy || capacity.inCooldown) return false;
    if (capability?.available === false || capability?.canRead === false) return false;
    if (assignment.mode === 'workspace-write' && capability?.canWrite === false) return false;
    return true;
  }

  async markTurn(turnId, patch) {
    await this.store.updateState((state) => {
      state.activeTurns[turnId] = {
        ...(state.activeTurns[turnId] ?? {}),
        ...patch,
      };
    });
  }

  async persistRuntimeState() {
    if (!this.store) {
      return;
    }
    await this.store.updateState((state) => {
      state.capacityLedger = structuredClone(this.ledger);
      state.writeLease = this.lease.snapshot();
      state.delegationMode = this.delegationMode;
    });
  }

  memoryStatus() {
    return {
      room: this.roomMemory
        ? {
            sourceThroughSequence: this.roomMemory.sourceThroughSequence,
            updatedAt: this.roomMemory.updatedAt,
          }
        : null,
      project: this.projectMemory
        ? {
            sourceThroughSequence: this.projectMemory.sourceThroughSequence,
            updatedAt: this.projectMemory.updatedAt,
            lastRoomId: this.projectMemory.lastRoomId,
          }
        : null,
      retainedTranscriptEvents: this.contextEvents.filter((event) => (
        event.sequence > (this.roomMemory?.sourceThroughSequence ?? 0)
      )).length,
      error: this.memoryError,
    };
  }

  getStatus() {
    const snapshot = getCapacitySnapshot(this.ledger, { now: this.now() });
    return {
      roomId: this.store.room.roomId,
      delegationMode: this.delegationMode,
      contextCapBytes: this.config?.contextCapBytes ?? null,
      modeProviders: structuredClone(this.config.modeProviders),
      stageProfiles: structuredClone(this.config.stageProfiles),
      memory: this.memoryStatus(),
      workflow: this.active?.workflow ?? null,
      activeStage: this.active?.stage ?? null,
      summary: `room=${this.store.room.roomId} mode=${this.delegationMode} capacity=configured/observed`,
      providers: PROVIDER_NAMES.map((name) => {
        const entry = snapshot.providers[name];
        return {
          name,
          availability: entry.availability,
          weight: entry.weight,
          cooldown: `${Math.ceil(entry.cooldownRemainingMs / 1000)}s`,
          failureStreak: entry.failureStreak,
          observedTurns: entry.observedTurns,
          observedTokens: entry.observedTokens,
          lastTurnTokens: entry.lastTurnTokens,
          capacitySource: entry.capacitySource,
          authStatus: this.providerStatus[name]?.authStatus ?? 'not-verified',
          providerVersion: this.providerStatus[name]?.providerVersion ?? null,
          trustStatus: this.providerStatus[name]?.trustStatus ?? 'unknown',
          canRead: this.providerStatus[name]?.canRead !== false,
          canWrite: this.providerStatus[name]?.canWrite !== false,
          supportsResume: this.providerStatus[name]?.supportsResume !== false,
          model: this.config[name].model ?? 'default',
          effort: this.config[name].effort ?? 'default',
          profile: name === 'codex'
            ? this.config.codex.configurationMode
            : this.config.claude.profileMode,
          contextCapBytes: this.config?.contextCapBytes ?? null,
          usageLimit: entry.usageReportedAt
            ? {
                status: entry.usageStatus,
                scope: entry.usageScope,
                resetsAt: entry.usageResetsAt,
                retryAfterSeconds: entry.usageRetryAfterSeconds,
                reportedAt: entry.usageReportedAt,
              }
            : null,
          usageLimitSource: entry.usageReportedAt ? 'provider-reported' : 'not-exposed',
        };
      }),
      activeProcess: this.active
        ? `${(this.active.currentProvider ?? [...this.active.providers].join('+')) || 'starting'}` +
          `${this.active.stage ? ` ${this.active.stage}` : ''} (${this.active.turnId})`
        : null,
      pendingClarifications: structuredClone(this.active?.clarifications?.items ?? []),
      pendingSupermodeContext: this.active?.pendingSupermodeContext?.length ?? 0,
      lease: this.lease.snapshot().current
        ? `${this.lease.snapshot().current.ownerProvider} write`
        : 'free',
    };
  }

  async persistUserConfig() {
    if (this.options.persistConfig === false) return;
    this.globalConfig = await saveConfig(this.globalConfig, {
      env: this.options.env,
      configPath: this.options.configPath,
      storageRoot: this.globalConfig.storageRoot,
    });
  }

  async updateWeight(provider, value) {
    setProviderWeight(this.ledger, provider, value);
    this.config.weights[provider] = value;
    this.globalConfig.weights[provider] = value;
    await this.persistRuntimeState();
    await this.persistUserConfig();
    await this.appendSystem(`${actorFor(provider)} scheduling weight set to ${value}.`);
  }

  async updateModel(provider, model) {
    const selectedModel = model ?? null;
    this.config[provider].model = selectedModel;
    this.globalConfig[provider].model = selectedModel;
    const adapter = this.providers[provider];
    if (typeof adapter?.setModel === 'function') {
      adapter.setModel(selectedModel);
    } else if (adapter) {
      adapter.model = selectedModel;
    }
    await this.persistUserConfig();
    await this.appendSystem(
      `${actorFor(provider)} model set to ${selectedModel ?? 'provider default'}.`,
    );
  }

  async updateEffort(provider, effort) {
    const selectedEffort = normalizeProviderEffort(provider, effort);
    this.config[provider].effort = selectedEffort;
    this.globalConfig[provider].effort = selectedEffort;
    const adapter = this.providers[provider];
    if (typeof adapter?.setEffort === 'function') {
      adapter.setEffort(selectedEffort);
    } else if (adapter) {
      adapter.effort = selectedEffort;
    }
    await this.persistUserConfig();
    await this.appendSystem(
      `${actorFor(provider)} effort set to ${selectedEffort ?? 'provider default'}.`,
    );
  }

  async updateDelegationMode(mode) {
    this.delegationMode = normalizeDelegationMode(mode);
    await this.store.updateState((state) => {
      state.delegationMode = this.delegationMode;
    });
    await this.appendSystem(`Delegation mode set to ${this.delegationMode}.`);
  }

  async updateModeProvider(lane, provider) {
    const canonicalLane = normalizeModeProviderLane(lane, null);
    const canonicalProvider = normalizeModeProvider(provider, null);
    if (!canonicalLane || !canonicalProvider) {
      throw new Error('Unsupported mode provider affinity.');
    }

    this.config.modeProviders[canonicalLane] = canonicalProvider;
    this.globalConfig.modeProviders[canonicalLane] = canonicalProvider;
    await this.persistUserConfig();
    await this.appendSystem(
      canonicalProvider === 'auto'
        ? `${canonicalLane.toUpperCase()} provider affinity reset to auto.`
        : `${canonicalLane.toUpperCase()} provider affinity set to ${actorFor(canonicalProvider)}.`,
    );
  }

  resolveAssignmentProfile(assignment) {
    const provider = assignment.provider;
    const globalProfile = this.config?.[provider] ?? {};
    const stageProfile = assignment.profileStage
      ? this.config?.stageProfiles?.[assignment.profileStage]?.[provider]
      : null;
    return {
      model: stageProfile?.model ?? globalProfile.model ?? null,
      effort: stageProfile?.effort ?? globalProfile.effort ?? null,
    };
  }

  async updateStageProfile(stage, provider, model, effort) {
    const canonicalStage = normalizeModeProviderLane(stage, null);
    const canonicalProvider = normalizeModeProvider(provider, null);
    if (!canonicalStage || !canonicalProvider) {
      throw new Error('Unsupported stage profile.');
    }

    if (canonicalProvider === 'auto') {
      this.config.modeProviders[canonicalStage] = 'auto';
      this.globalConfig.modeProviders[canonicalStage] = 'auto';
      for (const providerName of PROVIDER_NAMES) {
        this.config.stageProfiles[canonicalStage][providerName] = { model: null, effort: null };
        this.globalConfig.stageProfiles[canonicalStage][providerName] = { model: null, effort: null };
      }
    } else {
      const selectedModel = typeof model === 'string' && model.trim() ? model.trim() : null;
      const selectedEffort = normalizeProviderEffort(canonicalProvider, effort);
      if (effort != null && selectedEffort == null) {
        throw new Error(`Unsupported ${canonicalProvider} effort for ${canonicalStage}.`);
      }
      this.config.modeProviders[canonicalStage] = canonicalProvider;
      this.globalConfig.modeProviders[canonicalStage] = canonicalProvider;
      this.config.stageProfiles[canonicalStage][canonicalProvider] = {
        model: selectedModel,
        effort: selectedEffort,
      };
      this.globalConfig.stageProfiles[canonicalStage][canonicalProvider] = {
        model: selectedModel,
        effort: selectedEffort,
      };
    }

    await this.persistUserConfig();
    await this.appendSystem(
      canonicalProvider === 'auto'
        ? `${canonicalStage.toUpperCase()} stage profile reset to auto.`
        : `${canonicalStage.toUpperCase()} stage uses ${actorFor(canonicalProvider)} ` +
          `(${model ?? 'provider model'}, ${effort ?? 'provider effort'}).`,
    );
  }

  async newRoom() {
    const delegationMode = this.delegationMode;
    this.store = await createRoomStore({
      workspacePath: this.workspace,
      storageRoot: this.config.storageRoot,
      now: isoNow(this.now),
    });
    this.ledger = createCapacityLedger({ weights: this.config.weights, createdAt: isoNow(this.now) });
    for (const name of PROVIDER_NAMES) {
      setProviderAvailability(
        this.ledger,
        name,
        this.providerStatus[name]?.available ? 'available' : 'unavailable',
      );
    }
    this.lease = this.createWriteLease();
    this.delegationMode = normalizeDelegationMode(delegationMode);
    this.turnCounter = 0;
    this.contextEvents = [];
    this.roomMemory = null;
    this.projectMemory = await this.store.loadProjectMemory();
    this.memoryError = null;
    await this.persistRuntimeState();
    await this.appendSystem(`Started room ${this.store.room.roomId}.`);
  }

  async resumeRoom(roomId) {
    const resumed = await resumeRoomStore({
      workspacePath: this.workspace,
      storageRoot: this.config.storageRoot,
      roomId: roomId ?? null,
      now: isoNow(this.now),
    });
    if (!resumed) {
      await this.appendSystem(`Room ${roomId ?? 'latest'} was not found.`, 'warning');
      return;
    }
    this.store = resumed;
    this.hydrateRuntimeState();
    await this.detectProviders();
    await this.persistRuntimeState();
    await this.replayTranscript();
    try {
      await this.refreshMemory();
      this.memoryError = null;
    } catch (error) {
      this.memoryError = errorMessage(error);
    }
  }

  async cancel(reason = {}) {
    if (!this.active) {
      return false;
    }
    const active = this.active;
    active.controller.abort(reason.source ?? 'cancelled');
    await active.promise.catch(() => {});
    return true;
  }

  isBusy() {
    return Boolean(this.active);
  }

  isAwaitingInput() {
    return Boolean(
      this.active?.clarifications?.ready && this.active.clarifications.items?.length,
    );
  }

  async close() {
    if (this.closed) {
      return;
    }
    if (this.active) {
      await this.cancel({ source: 'shutdown', force: true });
    }
    await this.persistRuntimeState();
    this.closed = true;
  }

  async ensureStarted() {
    if (!this.started) {
      await this.start();
    }
  }
}

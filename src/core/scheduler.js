import { getCapacitySnapshot } from './capacity.js';
import {
  MODE_PROVIDER_LANES,
  normalizeDelegationMode,
  normalizeModeProvider,
} from './preferences.js';

const GREETING_PATTERN = /^(hi|hello|hey|yo|good (?:morning|afternoon|evening))(?:[!. ]|$)/iu;
const HELP_PATTERN = /\b(help|what can you do|usage|how do i)\b/iu;
const EXPLANATION_PATTERN = /\b(explain|why|what is|how does)\b/iu;
const READ_ONLY_OPENING_PATTERN = /^(?:please\s+)?(?:explain|why|what|how|review|audit|verify|check)\b/iu;
const READ_ONLY_INTENT_PATTERN =
  /\b(?:tell me|describe|explain|explanation|walk me through|summarize|what|why|how|review|audit|verify|check|analyze|inspect)\b/iu;
const COMPOUND_MUTATION_PATTERN =
  /(?:^|[,;:]|\b(?:and|then)\b)\s*(?:please\s+)?(?:build|change|fix|implement|refactor|write|create|add|update|remove|delete|edit|modify|apply|rename|move|polish|one[- ]shot)\b/iu;
const IMPLEMENTATION_PATTERN =
  /\b(build(?:s|ing)?|chang(?:e|es|ed|ing)|fix(?:es|ed|ing)?|implement(?:s|ed|ing)?|refactor(?:s|ed|ing)?|writ(?:e|es|ing|ten)|creat(?:e|es|ed|ing)|add(?:s|ed|ing)?|updat(?:e|es|ed|ing)|remov(?:e|es|ed|ing)|delet(?:e|es|ed|ing)|edit(?:s|ed|ing)?|modif(?:y|ies|ied|ying)|appl(?:y|ies|ied|ying)|renam(?:e|es|ed|ing)|mov(?:e|es|ed|ing)|polish(?:es|ed|ing)?|one[- ]shot(?:s|ting)?)\b/iu;
const DIAGNOSIS_PATTERN = /\b(debug|diagnose|diagnosis|investigate|root cause|why is|failure|broken|error)\b/iu;
const REVIEW_PATTERN = /\b(review|security|audit|test|qa|verify|coverage)\b/iu;
const UX_SIGNAL_PATTERN =
  /\b(?:ui|ux|user (?:interface|experience)|front[ -]?end|layout|spacing|visual (?:design|hierarchy|polish)|interaction design|typography|responsive|accessibility|a11y|onboarding|design system|command palette|terminal (?:ui|interface|experience)|cli (?:ui|interface|experience|prompt|output))\b/iu;
const SECURITY_REVIEW_PATTERN =
  /\b(?:security|secure|vulnerabilit(?:y|ies)|threat|auth(?:entication|orization)?|privilege|permissions?|injection|xss|csrf|secrets?)\b/iu;
const TEST_REVIEW_PATTERN =
  /\b(?:tests?|testing|qa|coverage|flak(?:e|es|y|iness)|regression(?:s)?|test suite)\b/iu;
const CODE_REVIEW_PATTERN =
  /\b(?:code|source|implementation|parser|function|method|class|module|api|diff|pull request|repository|repo|database|schema|fix)\b/iu;
const PLAN_LANE_PATTERN = /\b(?:plan|planning|roadmap|strategy|implementation sequence|migration sequence)\b/iu;
const EXECUTE_LANE_PATTERN = /\b(?:deploy|deployment|ship|release|publish|launch|roll[ -]?out|execute)\b/iu;

function normalizeRoute(route) {
  return route ?? 'auto';
}

function normalizeClassificationInput(input = {}) {
  const delegationMode = normalizeDelegationMode(input.delegationMode);
  return {
    route: normalizeRoute(input.route),
    delegationMode,
    delegationModeSpecified: input.delegationMode != null && delegationMode !== 'auto',
    prompt: input.prompt,
  };
}

function applyDelegationMode(classification, delegationMode, delegationModeSpecified) {
  const effectiveDelegationMode = delegationModeSpecified ? delegationMode : classification.delegationMode ?? null;
  let next = classification;

  if (effectiveDelegationMode === 'plan') {
    next = {
      ...next,
      helperWanted: true,
      writerRequired: false,
    };
  } else if (effectiveDelegationMode === 'code' || effectiveDelegationMode === 'execute') {
    next = {
      ...next,
      helperWanted: true,
      writerRequired: true,
    };
  } else if (effectiveDelegationMode === 'ux') {
    next = {
      ...next,
      helperWanted: true,
      writerRequired: next.kind !== 'review',
    };
  }

  if (!effectiveDelegationMode) {
    return next;
  }

  return {
    ...next,
    delegationMode: effectiveDelegationMode,
    taskLane: effectiveDelegationMode,
  };
}

function inferTaskLane(prompt, classification) {
  const text = `${prompt ?? ''}`.trim();
  if (classification.kind === 'review') {
    if (classification.reviewFocus === 'ux') return 'ux';
    if (['security', 'code-review', 'test-review'].includes(classification.reviewFocus)) return 'code';
    if (classification.reviewFocus === 'general-audit') return null;
  }

  if (UX_SIGNAL_PATTERN.test(text)) {
    return 'ux';
  }

  if (classification.kind === 'implementation') {
    if (EXECUTE_LANE_PATTERN.test(text)) return 'execute';
    if (PLAN_LANE_PATTERN.test(text) && !COMPOUND_MUTATION_PATTERN.test(text)) return 'plan';
    return 'code';
  }

  if (PLAN_LANE_PATTERN.test(text)) return 'plan';
  if (EXECUTE_LANE_PATTERN.test(text)) return 'execute';
  return null;
}

function inferReviewFocus(prompt, classification) {
  if (classification.kind !== 'review') {
    return null;
  }

  const text = `${prompt ?? ''}`.trim();
  if (SECURITY_REVIEW_PATTERN.test(text)) return 'security';
  if (TEST_REVIEW_PATTERN.test(text)) return 'test-review';
  if (UX_SIGNAL_PATTERN.test(text)) return 'ux';
  if (CODE_REVIEW_PATTERN.test(text)) return 'code-review';
  if (/\baudits?\b/iu.test(text)) return 'general-audit';
  return 'general-review';
}

function classifyDirectPrompt(prompt) {
  const text = `${prompt ?? ''}`.trim();

  if (!text) {
    return { kind: 'trivial', reason: 'empty', helperWanted: false, writerRequired: false };
  }

  if (/^(?:test|tests)$/iu.test(text)) {
    return { kind: 'trivial', reason: 'default-single-provider', helperWanted: false, writerRequired: false };
  }

  const compoundMutation = COMPOUND_MUTATION_PATTERN.test(text);

  if ((GREETING_PATTERN.test(text) || HELP_PATTERN.test(text)) && !compoundMutation) {
    return { kind: 'trivial', reason: 'greeting-or-help', helperWanted: false, writerRequired: false };
  }

  if ((READ_ONLY_OPENING_PATTERN.test(text) || READ_ONLY_INTENT_PATTERN.test(text)) && !compoundMutation) {
    if (REVIEW_PATTERN.test(text)) {
      return { kind: 'review', reason: 'explicit-review-intent', helperWanted: true, writerRequired: false };
    }
    if (text.length > 120) {
      return { kind: 'analysis', reason: 'explicit-read-only-analysis', helperWanted: true, writerRequired: false };
    }
    return { kind: 'trivial', reason: 'explicit-read-only-intent', helperWanted: false, writerRequired: false };
  }

  if (IMPLEMENTATION_PATTERN.test(text)) {
    return { kind: 'implementation', reason: 'implementation-keyword', helperWanted: true, writerRequired: true };
  }

  if (DIAGNOSIS_PATTERN.test(text)) {
    return { kind: 'diagnosis', reason: 'diagnosis-keyword', helperWanted: true, writerRequired: false };
  }

  if (REVIEW_PATTERN.test(text)) {
    return { kind: 'review', reason: 'review-keyword', helperWanted: true, writerRequired: false };
  }

  const shortPrompt = text.length <= 120;

  if (shortPrompt && EXPLANATION_PATTERN.test(text)) {
    return { kind: 'trivial', reason: 'short-explanation', helperWanted: false, writerRequired: false };
  }

  if (text.length > 120) {
    return { kind: 'analysis', reason: 'long-ambiguous-read-only', helperWanted: true, writerRequired: false };
  }

  return { kind: 'trivial', reason: 'default-single-provider', helperWanted: false, writerRequired: false };
}

export function classifyTurn(input = {}) {
  const { route, delegationMode, delegationModeSpecified, prompt } = normalizeClassificationInput(input);
  const directClassification = classifyDirectPrompt(prompt);
  const reviewFocus = inferReviewFocus(prompt, directClassification);
  const focusedClassification = reviewFocus
    ? { ...directClassification, reviewFocus }
    : directClassification;
  const inferredTaskLane = inferTaskLane(prompt, focusedClassification);
  const classifiedPrompt = inferredTaskLane
    ? {
        ...focusedClassification,
        taskLane: inferredTaskLane,
        ...(inferredTaskLane === 'ux' && ['implementation', 'review'].includes(focusedClassification.kind)
          ? { delegationMode: 'ux' }
          : {}),
      }
    : focusedClassification;

  if (route === 'both') {
    const classification = applyDelegationMode(classifiedPrompt, delegationMode, delegationModeSpecified);
    return { ...classification, helperWanted: true, route };
  }

  if (route === 'codex' || route === 'claude') {
    const classification = applyDelegationMode(classifiedPrompt, delegationMode, delegationModeSpecified);
    return { ...classification, helperWanted: false, route };
  }

  return { ...applyDelegationMode(classifiedPrompt, delegationMode, delegationModeSpecified), route };
}

function rankLeadCandidate(candidate, provider, defaultWriter = null) {
  return [
    candidate.weight,
    candidate.workspaceStickiness + candidate.sessionStickiness,
    candidate.busy ? 0 : 1,
    -candidate.failureStreak,
    defaultWriter && provider === defaultWriter ? 1 : 0,
    -candidate.observedLeadTurns,
    -candidate.observedTurns,
    provider === 'codex' ? 1 : 0,
  ];
}

function compareRanks(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] === right[index]) {
      continue;
    }

    return right[index] - left[index];
  }

  return 0;
}

function getAvailableProviders(snapshot) {
  return Object.entries(snapshot.providers)
    .filter(([, entry]) => entry.available)
    .map(([provider]) => provider)
    .sort();
}

function chooseLead(snapshot, requestedProvider = null, defaultWriter = null) {
  const availableProviders = getAvailableProviders(snapshot);

  if (requestedProvider) {
    const requested = snapshot.providers[requestedProvider];

    if (!requested || !requested.available) {
      return null;
    }

    if (!requested.inCooldown) {
      return requestedProvider;
    }

    return availableProviders.length === 1 ? requestedProvider : null;
  }

  const candidates = availableProviders
    .filter((provider) => !snapshot.providers[provider].inCooldown)
    .map((provider) => ({
      provider,
      rank: rankLeadCandidate(snapshot.providers[provider], provider, defaultWriter),
    }))
    .sort((left, right) => compareRanks(left.rank, right.rank) || left.provider.localeCompare(right.provider));

  return candidates[0]?.provider ?? null;
}

function chooseHelper(snapshot, leadProvider, preferredProvider = null) {
  if (preferredProvider && preferredProvider !== leadProvider) {
    const preferred = snapshot.providers[preferredProvider];
    if (preferred?.available && !preferred.busy && !preferred.inCooldown) {
      return preferredProvider;
    }
  }

  const candidates = getAvailableProviders(snapshot)
    .filter((provider) => provider !== leadProvider)
    .map((provider) => ({
      provider,
      entry: snapshot.providers[provider],
    }))
    .filter(({ entry }) => !entry.busy && !entry.inCooldown)
    .sort((left, right) => {
      const leftRank = [
        left.entry.weight,
        left.entry.workspaceStickiness + left.entry.sessionStickiness,
        -left.entry.failureStreak,
        -left.entry.observedHelperTurns,
        -left.entry.observedTurns,
      ];
      const rightRank = [
        right.entry.weight,
        right.entry.workspaceStickiness + right.entry.sessionStickiness,
        -right.entry.failureStreak,
        -right.entry.observedHelperTurns,
        -right.entry.observedTurns,
      ];

      return compareRanks(leftRank, rightRank) || left.provider.localeCompare(right.provider);
    });

  return candidates[0]?.provider ?? null;
}

export function assignComplementaryRoles(classification, leadProvider, helperProvider = null) {
  const helperActor = helperProvider ?? null;
  const delegationMode = normalizeDelegationMode(classification?.delegationMode);

  if (delegationMode === 'plan') {
    return {
      lead: {
        provider: leadProvider,
        role: 'planning-lead',
        mode: 'read-only',
        profileStage: 'plan',
      },
      helper: helperActor
        ? {
            provider: helperActor,
            role: 'plan-critic',
            mode: 'read-only',
            profileStage: 'review',
          }
        : null,
    };
  }

  if (delegationMode === 'code') {
    return {
      lead: {
        provider: leadProvider,
        role: 'coding-lead',
        mode: 'workspace-write',
        profileStage: 'code',
      },
      helper: helperActor
        ? {
            provider: helperActor,
            role: 'code-reviewer',
            mode: 'read-only',
            profileStage: 'review',
          }
        : null,
    };
  }

  if (delegationMode === 'execute') {
    return {
      lead: {
        provider: leadProvider,
        role: 'execution-lead',
        mode: 'workspace-write',
        profileStage: 'execute',
      },
      helper: helperActor
        ? {
            provider: helperActor,
            role: 'verifier',
            mode: 'read-only',
            profileStage: 'review',
          }
        : null,
    };
  }

  if (delegationMode === 'ux') {
    return {
      lead: {
        provider: leadProvider,
        role: classification.kind === 'review' ? 'ux-reviewer' : 'ux-implementation-lead',
        mode: classification.kind === 'review' ? 'read-only' : 'workspace-write',
        profileStage: classification.kind === 'review' ? 'review' : 'ux',
      },
      helper: helperActor
        ? {
            provider: helperActor,
            role: classification.kind === 'review' ? 'independent-checker' : 'ux-reviewer',
            mode: 'read-only',
            profileStage: 'review',
          }
        : null,
    };
  }

  switch (classification.kind) {
    case 'implementation':
      return {
        lead: {
          provider: leadProvider,
          role: 'implementation-lead',
          mode: 'workspace-write',
          profileStage: 'code',
        },
        helper: helperActor
          ? {
              provider: helperActor,
              role: 'read-only-reviewer',
              mode: 'read-only',
              profileStage: 'review',
            }
          : null,
      };

    case 'diagnosis':
      return {
        lead: {
          provider: leadProvider,
          role: 'debugging-lead',
          mode: 'read-only',
        },
        helper: helperActor
          ? {
              provider: helperActor,
              role: 'independent-root-cause-reviewer',
              mode: 'read-only',
            }
          : null,
      };

    case 'review':
      {
        const roles = {
          'general-audit': ['technical-audit-lead', 'technical-audit-checker'],
          security: ['security-review-lead', 'security-review-checker'],
          'code-review': ['code-review-lead', 'code-review-checker'],
          'test-review': ['test-review-lead', 'test-review-checker'],
        }[classification.reviewFocus] ?? ['specialist-review-lead', 'independent-checker'];
      return {
        lead: {
          provider: leadProvider,
          role: roles[0],
          mode: 'read-only',
          profileStage: 'review',
        },
        helper: helperActor
          ? {
              provider: helperActor,
              role: roles[1],
              mode: 'read-only',
              profileStage: 'review',
            }
          : null,
      };
      }

    case 'analysis':
      return {
        lead: {
          provider: leadProvider,
          role: 'analysis-lead',
          mode: 'read-only',
        },
        helper: helperActor
          ? {
              provider: helperActor,
              role: 'independent-analyst',
              mode: 'read-only',
            }
          : null,
      };

    default:
      return {
        lead: {
          provider: leadProvider,
          role: 'direct-turn',
          mode: 'read-only',
        },
        helper: helperActor
          ? {
              provider: helperActor,
              role: 'secondary-visible-participant',
              mode: 'read-only',
            }
          : null,
      };
  }
}

function choosePreferredProvider(snapshot, classification, modeProviders = null) {
  const lane = classification?.taskLane ?? classification?.delegationMode;
  const stages = [
    ...(classification?.kind === 'review' ? ['review'] : []),
    ...(MODE_PROVIDER_LANES.includes(lane) && lane !== 'review' ? [lane] : []),
  ];

  for (const stage of stages) {
    const preferredProvider = normalizeModeProvider(modeProviders?.[stage], 'auto');
    if (preferredProvider === 'auto') {
      continue;
    }

    const preferredEntry = snapshot.providers[preferredProvider];
    if (preferredEntry?.available && !preferredEntry.inCooldown) {
      return preferredProvider;
    }
  }

  return null;
}

function choosePreferredReviewHelper(snapshot, leadProvider, modeProviders = null) {
  const preferredProvider = normalizeModeProvider(modeProviders?.review, 'auto');
  if (preferredProvider === 'auto' || preferredProvider === leadProvider) {
    return null;
  }

  const preferredEntry = snapshot.providers[preferredProvider];
  return preferredEntry?.available && !preferredEntry.busy && !preferredEntry.inCooldown
    ? preferredProvider
    : null;
}

function chooseConfiguredStageProvider(snapshot, modeProviders, stage) {
  const preferredProvider = normalizeModeProvider(modeProviders?.[stage], 'auto');
  if (preferredProvider === 'auto') {
    return null;
  }

  const preferredEntry = snapshot.providers[preferredProvider];
  return preferredEntry?.available && !preferredEntry.inCooldown
    ? preferredProvider
    : null;
}

/**
 * Build the sequential assignments for an explicit supermode turn.
 *
 * The executor is selected first because both automatic planning and review
 * prefer an independent provider relative to the actor that owns execution.
 * Configured stage providers are affinities: unavailable or cooling providers
 * fall back to the normal capacity-aware selection path.
 */
export function createSupermodePlan(input = {}, ledger, options = {}) {
  const initialClassification = classifyTurn(input);
  const prompt = String(input.prompt ?? '');
  const planOnly = [
    /\b(?:plan only|only plan|only (?:produce|create|draft|return|give me) (?:a |the )?plan)\b/iu,
    /\b(?:do not|don't|never)\s+(?:execute|implement|build|change|write|modify|edit)\b/iu,
    /\b(?:no|without)\s+(?:workspace |code )?(?:changes?|edits?|modifications?)\b/iu,
    /\bkeep\s+(?:this|it|the (?:task|turn|workspace))\s+read[- ]only\b/iu,
    /\b(?:this|it|the (?:task|turn|workspace))\s+(?:must|should)\s+(?:remain|stay|be)\s+read[- ]only\b/iu,
  ].some((pattern) => pattern.test(prompt));
  const classification = planOnly
    ? {
        ...initialClassification,
        kind: 'planning',
        reason: 'explicit-read-only-supermode',
        taskLane: 'plan',
        helperWanted: true,
        writerRequired: false,
      }
    : (!initialClassification.writerRequired && initialClassification.taskLane === 'plan')
      ? {
        ...initialClassification,
        kind: 'implementation',
        reason: 'supermode-plan-execution',
        helperWanted: true,
        writerRequired: true,
      }
      : initialClassification;
  const snapshot = getCapacitySnapshot(ledger, { now: options.now });
  const configuredExecutor = chooseConfiguredStageProvider(
    snapshot,
    input.modeProviders,
    'execute',
  );
  const executorProvider = configuredExecutor ?? chooseLead(snapshot);

  if (!executorProvider) {
    return {
      ok: false,
      classification,
      reason: 'No provider is currently eligible to execute supermode',
      snapshot,
    };
  }

  const configuredPlanner = chooseConfiguredStageProvider(
    snapshot,
    input.modeProviders,
    'plan',
  );
  const plannerProvider = configuredPlanner
    ?? chooseHelper(snapshot, executorProvider)
    ?? executorProvider;
  const configuredReviewer = chooseConfiguredStageProvider(
    snapshot,
    input.modeProviders,
    'review',
  );
  const reviewerProvider = configuredReviewer
    ?? chooseHelper(snapshot, executorProvider)
    ?? executorProvider;
  const executorMode = classification.writerRequired ? 'workspace-write' : 'read-only';

  return {
    ok: true,
    classification,
    planner: {
      provider: plannerProvider,
      role: 'planning-lead',
      mode: 'read-only',
      profileStage: 'plan',
      label: 'plan',
    },
    executor: {
      provider: executorProvider,
      role: classification.writerRequired ? 'execution-lead' : 'analysis-lead',
      mode: executorMode,
      profileStage: 'execute',
      label: 'execute',
    },
    reviewer: {
      provider: reviewerProvider,
      role: classification.writerRequired ? 'code-reviewer' : 'independent-checker',
      mode: 'read-only',
      profileStage: 'review',
      label: 'review',
    },
    requiresWriteLease: classification.writerRequired && executorMode === 'workspace-write',
    snapshot,
  };
}

export function createDispatchPlan(input = {}, ledger, options = {}) {
  const classification = classifyTurn(input);
  const snapshot = getCapacitySnapshot(ledger, { now: options.now });
  const requestedProvider =
    classification.route === 'codex' || classification.route === 'claude' ? classification.route : null;
  const preferredProvider = requestedProvider
    ? null
    : choosePreferredProvider(snapshot, classification, input.modeProviders);
  const leadProvider = requestedProvider
    ? chooseLead(snapshot, requestedProvider)
    : preferredProvider ?? chooseLead(
        snapshot,
        null,
        classification.writerRequired ? 'codex' : null,
      );

  if (!leadProvider) {
    return {
      ok: false,
      classification,
      reason: requestedProvider
        ? `Requested provider ${requestedProvider} is unavailable or cooling down`
        : 'No provider is currently eligible to lead',
      snapshot,
    };
  }

  const preferredReviewHelper = choosePreferredReviewHelper(
    snapshot,
    leadProvider,
    input.modeProviders,
  );
  const helperProvider = classification.helperWanted
    ? chooseHelper(snapshot, leadProvider, preferredReviewHelper)
    : null;
  const assignments = assignComplementaryRoles(classification, leadProvider, helperProvider);

  return {
    ok: true,
    classification,
    lead: assignments.lead,
    helper: assignments.helper,
    requiresWriteLease: classification.writerRequired && assignments.lead.mode === 'workspace-write',
    snapshot,
  };
}

/**
 * Deterministic scheduler wrapper for room lead/helper assignment.
 */
export class Scheduler {
  /**
   * @param {object} ledger
   */
  constructor(ledger) {
    this.ledger = ledger?.state ?? ledger;
  }

  /**
   * @param {{route?: string, prompt?: string}} input
   */
  classify(input = {}) {
    return classifyTurn(input);
  }

  /**
   * @param {{route?: string, prompt?: string}} input
   * @param {{now?: string | number | Date}} [options]
   */
  createDispatchPlan(input = {}, options = {}) {
    return createDispatchPlan(input, this.ledger, options);
  }

  /**
   * @param {{route?: string, prompt?: string, modeProviders?: object}} input
   * @param {{now?: string | number | Date}} [options]
   */
  createSupermodePlan(input = {}, options = {}) {
    return createSupermodePlan(input, this.ledger, options);
  }

  /**
   * @param {{kind: string}} classification
   * @param {string} leadProvider
   * @param {string | null} [helperProvider]
   */
  assignRoles(classification, leadProvider, helperProvider = null) {
    return assignComplementaryRoles(classification, leadProvider, helperProvider);
  }
}

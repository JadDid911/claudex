import { MODE_PROVIDER_LANES } from '../core/preferences.js';
import { MarkdownStreamStyler } from './markdown-stream.js';

const ANSI_PATTERN = /\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;
const CONTROL_PATTERN = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;

const ACTOR_NAMES = new Set(['YOU', 'SYSTEM', 'CODEX', 'CLAUDE']);
const ACTIVITY_SPINNER_FRAMES = ['\u280b', '\u2819', '\u2839', '\u2838', '\u283c', '\u2834', '\u2826', '\u2827', '\u2807', '\u280f'];
const ACTIVITY_VERBS = [
  'Gallivanting\u2026',
  'Puttering\u2026',
  'Tinkering\u2026',
  'Scouting\u2026',
  'Wrangling\u2026',
];
const ERASE_LINE = '\r\u001B[2K';
const PRODUCT_HEADER = 'CLAUDEX';
const ROOM_HEADER = 'ROOM';
const RESET = '\u001B[0m';
const ACTIVITY_COLOR = '\u001B[33m';
const WARNING_COLOR = '\u001B[1;33m';

export function sanitizeVisibleText(value) {
  return String(value ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(ANSI_PATTERN, '')
    .replace(CONTROL_PATTERN, '');
}

export function createTranscriptRenderer(options = {}) {
  return new TranscriptRenderer(options);
}

class TranscriptRenderer {
  constructor({
    output = process.stdout,
    color = output.isTTY ?? false,
    setActivityTimer = setInterval,
    clearActivityTimer = clearInterval,
    activityIntervalMs = 120,
  } = {}) {
    this.output = output;
    this.isTTY = Boolean(output.isTTY ?? false);
    this.color = this.isTTY && prefersColor(color);
    this.blockKey = null;
    this.atLineStart = true;
    this.activityEntries = new Map();
    this.activityVisible = false;
    this.activityTimer = null;
    this.activityFrame = 0;
    this.setActivityTimer = setActivityTimer;
    this.clearActivityTimer = clearActivityTimer;
    this.activityIntervalMs = activityIntervalMs;
    this.firstBlock = true;
    this.bodyStream = null;
  }

  renderStartup(snapshot = {}) {
    if (this.isTTY) {
      const columns = Math.max(8, Number(this.output.columns) || 100);
      this.writeIdentityCard(formatStartupIdentityCard(snapshot, columns, this.color));
      return;
    }

    const lines = [
      `claudex ${snapshot.version ?? ''}`.trim(),
      `workspace: ${sanitizeVisibleText(snapshot.workspace ?? process.cwd())}`,
      `room id: ${sanitizeVisibleText(snapshot.roomId ?? 'pending')}`,
      snapshot.author ? `author: ${sanitizeVisibleText(snapshot.author)}` : null,
      snapshot.repository ? `repository: ${sanitizeVisibleText(snapshot.repository)}` : null,
      `providers: ${formatProviderSummary(snapshot.providers)}`,
      `routing: ${sanitizeVisibleText(snapshot.routingMode ?? 'auto')}`,
      `safety: ${sanitizeVisibleText(snapshot.safetyMode ?? 'single-writer')}`,
    ];

    if (snapshot.resumeLabel) {
      lines.push(`resume: ${sanitizeVisibleText(snapshot.resumeLabel)}`);
    }

    this.writeBlock('SYSTEM', lines.join('\n'));
  }

  renderHelp(text) {
    this.writeBlock('SYSTEM', sanitizeVisibleText(text));
  }

  renderStatus(status) {
    if (this.isTTY) {
      this.renderCompactStatus(status);
      return;
    }

    const lines = [];

    if (status.summary) {
      lines.push(sanitizeVisibleText(status.summary));
    }

    if (Array.isArray(status.providers) && status.providers.length > 0) {
      for (const provider of status.providers) {
        const contextLimit = formatByteSize(provider.sharedContextBytes ?? provider.contextCapBytes ?? status.contextCapBytes);
        const modelContext = formatTokenCount(provider.modelContextTokens);
        const usageSummary = formatUsageSummary(provider);
        const usageLimitSummary = formatUsageLimitSummary(provider);
        lines.push(
          `${sanitizeVisibleText(provider.name)}: ` +
            [
              `availability=${sanitizeVisibleText(provider.availability ?? 'unknown')}`,
              `weight=${sanitizeVisibleText(provider.weight ?? 'n/a')}`,
              `cooldown=${sanitizeVisibleText(provider.cooldown ?? '0s')}`,
              `failures=${sanitizeVisibleText(provider.failureStreak ?? '0')}`,
              `turns=${sanitizeVisibleText(provider.observedTurns ?? '0')}`,
              `tokens=${sanitizeVisibleText(provider.observedTokens ?? '0')}`,
              `capacity=${sanitizeVisibleText(provider.capacitySource ?? 'configured')}`,
              `model=${sanitizeVisibleText(provider.model ?? 'default')}`,
              `effort=${sanitizeVisibleText(provider.effort ?? 'default')}`,
              `profile=${sanitizeVisibleText(provider.profile ?? 'default')}`,
              `modelContext=${sanitizeVisibleText(modelContext)}`,
              contextLimit ? `context=${sanitizeVisibleText(contextLimit)}` : null,
              usageSummary ? `usage=${sanitizeVisibleText(usageSummary)}` : null,
              `usageLimit=${sanitizeVisibleText(usageLimitSummary)}`,
              `auth=${sanitizeVisibleText(provider.authStatus ?? 'not-verified')}`,
            ].filter(Boolean).join(' ')
        );
      }
    }

    if (status.activeProcess) {
      lines.push(`active: ${sanitizeVisibleText(status.activeProcess)}`);
    }

    if (status.lease) {
      lines.push(`lease: ${sanitizeVisibleText(status.lease)}`);
    }

    const laneSummary = formatModeProviders(status.modeProviders, '=');
    if (laneSummary) {
      lines.push(`lanes: ${laneSummary}`);
    }
    const profileSummary = formatStageProfiles(status.stageProfiles, status.modeProviders, '=');
    if (profileSummary) {
      lines.push(`profiles: ${profileSummary}`);
    }

    this.writeBlock('SYSTEM', lines.join('\n') || 'No status available.');
  }

  renderCompactStatus(status = {}) {
    const columns = Math.max(40, Number(this.output.columns) || 80);
    const room = compactRoomId(status.roomId ?? 'unknown');
    const mode = sanitizeVisibleText(status.delegationMode ?? 'auto');
    const processState = status.activeProcess
      ? [status.workflow, status.activeStage].filter(Boolean).map(sanitizeVisibleText).join(':') || 'busy'
      : 'idle';
    const lease = sanitizeVisibleText(status.lease ?? 'free');
    const lines = [`${room} \u00b7 mode ${mode} \u00b7 ${processState} \u00b7 lease ${lease}`];

    for (const provider of Array.isArray(status.providers) ? status.providers : []) {
      const state = providerState(provider);
      const modelContext = formatTokenCount(provider.modelContextTokens);
      const facts = [
        sanitizeVisibleText(provider.name ?? 'provider').toUpperCase(),
        state,
        compactModelLabel(provider),
        `model ctx ${sanitizeVisibleText(modelContext)}`,
        `effort ${sanitizeVisibleText(provider.effort ?? 'default')}`,
        `weight ${sanitizeVisibleText(provider.weight ?? 'n/a')}`,
      ];
      const contextLimit = formatByteSize(provider.sharedContextBytes ?? provider.contextCapBytes ?? status.contextCapBytes);
      const usageSummary = formatUsageSummary(provider);
      const usageLimitSummary = formatUsageLimitSummary(provider);
      if (columns >= 90 && contextLimit) facts.push(`context ${sanitizeVisibleText(contextLimit)}`);
      if (provider.sharedContextBytes && columns >= 110) facts.push(`shared ${sanitizeVisibleText(formatByteSize(provider.sharedContextBytes))}`);
      if (columns >= 110 && usageSummary) facts.push(`usage ${sanitizeVisibleText(usageSummary)}`);
      if (columns >= 110) facts.push(`usage limit ${sanitizeVisibleText(usageLimitSummary)}`);
      else {
          if (Number(provider.observedTurns) > 0) facts.push(`${provider.observedTurns} turns`);
          if (Number(provider.observedTokens) > 0) facts.push(`${provider.observedTokens} tokens`);
          if (Number(provider.lastTurnTokens) > 0) facts.push(`last ${provider.lastTurnTokens} tokens`);
        }
      if (provider.cooldown && provider.cooldown !== '0s') facts.push(`cooldown ${sanitizeVisibleText(provider.cooldown)}`);
      lines.push(facts.join(' \u00b7 '));
    }

    const laneSummary = formatModeProviders(status.modeProviders, '\u2192');
    if (laneSummary) lines.push(`lanes \u00b7 ${laneSummary}`);
    const profileSummary = formatStageProfiles(status.stageProfiles, status.modeProviders, '\u2192');
    if (profileSummary) lines.push(`profiles \u00b7 ${profileSummary}`);

    this.writeBlock('SYSTEM', lines.join('\n') || 'No status available.');
  }

  renderEvent(event = {}) {
    const actor = normalizeActor(event.actor);
    const label = event.label || event.mode || null;
    const text = sanitizeVisibleText(event.text ?? event.content ?? '');

    if (event.type !== 'delta') {
      this.flushPendingBodyStream();
    }

    switch (event.type) {
      case 'delta':
        if (this.shouldHideHelperProse(actor, label)) {
          this.updateActivityLine(actor, label, 'Reviewing in background...');
        } else {
          this.appendStream(actor, label, text);
        }
        break;
      case 'activity':
        this.renderActivity(actor, label, text || event.detail || 'Working...');
        break;
      case 'activity.finish':
        this.removeActivityLine(actor, label);
        break;
      case 'tool':
        if (this.shouldRenderQuietActivity(actor)) {
          this.updateActivityLine(actor, label, formatQuietToolText(event));
          break;
        }
        this.writeBlock(actor, formatToolLine(event));
        break;
      case 'warning':
        if (this.isTTY && actor !== 'SYSTEM') {
          this.writeProviderWarning(actor, text || 'Warning');
        } else {
          this.writeBlock(actor, prefixLines(text || 'Warning', '! '));
        }
        break;
      case 'status':
        if (this.shouldRenderQuietActivity(actor)) {
          const lifecycle = event.metadata?.providerEventType;
          if (lifecycle === 'turn.finish') {
            this.removeActivityLine(actor, label);
          } else if (!['session', 'usage'].includes(lifecycle)) {
            this.updateActivityLine(actor, label, text || 'Status updated');
          }
          break;
        }
        this.writeBlock(actor, prefixLines(text || 'Status updated', '- '));
        break;
      default:
        if (this.shouldHideHelperProse(actor, label)) {
          this.updateActivityLine(actor, label, 'Reviewing in background...');
        } else {
          this.writeBlock(actor, text || '[no visible content]', label);
        }
        break;
    }
  }

  renderMessage(actor, text, label = null) {
    this.writeBlock(actor, sanitizeVisibleText(text), label);
  }

  renderActivity(actor, label, text) {
    const visible = `... ${sanitizeVisibleText(text)}`;

    if (!this.shouldRenderQuietActivity(actor)) {
      this.writeBlock(actor, visible, label);
      return;
    }

    this.updateActivityLine(actor, label, sanitizeVisibleText(text));
  }

  finish() {
    this.clearEphemeral();
    this.flushPendingBodyStream();
    if (!this.atLineStart) {
      this.output.write('\n');
      this.atLineStart = true;
    }
  }

  appendStream(actor, label, text) {
    this.suspendEphemeral({ pauseTimer: true });
    this.prepareBodyStream(actor, label, this.shouldStyleMarkdown(actor));
    this.ensureBlock(actor, label, { stream: true });
    this.writeBody(text, { markdown: this.shouldStyleMarkdown(actor), final: false });
  }

  writeBlock(actor, body, label = null, { markdown = this.shouldStyleMarkdown(actor) } = {}) {
    this.suspendEphemeral();
    if (this.isTTY && normalizeActor(actor) === 'SYSTEM') {
      this.flushPendingBodyStream();
      this.writeRoomLines(body);
      this.resumeEphemeral();
      return;
    }
    this.flushPendingBodyStream();
    this.ensureBlock(actor, label, { stream: false });
    const text = sanitizeVisibleText(body);
    this.writeBody(text, { markdown, final: true });
    if (!text.endsWith('\n')) {
      this.output.write('\n');
    }
    this.atLineStart = true;
    this.blockKey = null;
    this.resumeEphemeral();
  }

  writeBody(text, { markdown = false, final = true } = {}) {
    const visible = markdown ? this.renderMarkdownBody(text, final) : text;
    let output = '';

    for (const character of visible) {
      if (this.atLineStart && character !== '\n') {
        output += '  ';
        this.atLineStart = false;
      }

      output += character;
      if (character === '\n') {
        this.atLineStart = true;
      }
    }

    this.output.write(output);
  }

  ensureBlock(actor, label, { stream }) {
    const key = `${normalizeActor(actor)}::${label ?? ''}`;

    if (!stream || this.blockKey !== key) {
      if (!this.atLineStart) {
        this.output.write('\n');
        this.atLineStart = true;
      }

      if (!this.firstBlock) {
        this.output.write('\n');
      }

      this.output.write(formatHeader(actor, label, this.color, this.isTTY));
      this.output.write('\n');
      this.firstBlock = false;
      this.blockKey = stream ? key : null;
      this.atLineStart = true;
    }
  }

  clearEphemeral() {
    if (!this.activityVisible && this.activityEntries.size === 0) {
      return;
    }

    this.suspendEphemeral({ pauseTimer: true });
    this.activityEntries.clear();
    this.activityFrame = 0;
  }

  suspendEphemeral({ pauseTimer = false } = {}) {
    if (pauseTimer) {
      this.stopActivityTimer();
    }
    if (!this.activityVisible) {
      return;
    }

    this.output.write(ERASE_LINE);
    this.activityVisible = false;
    this.atLineStart = true;
  }

  resumeEphemeral() {
    if (this.activityEntries.size === 0) {
      return;
    }

    this.paintActivityLine();
    this.ensureActivityTimer();
  }

  shouldRenderQuietActivity(actor) {
    return this.isTTY && normalizeActor(actor) !== 'SYSTEM';
  }

  shouldHideHelperProse(actor, label) {
    return label === 'helper' && this.shouldRenderQuietActivity(actor);
  }

  updateActivityLine(actor, label, detail) {
    const key = activityKey(actor, label);
    const current = this.activityEntries.get(key);
    if (current) {
      current.detail = sanitizeVisibleText(detail);
    } else {
      this.activityEntries.set(key, {
        actor,
        label,
        detail: sanitizeVisibleText(detail),
      });
    }
    this.paintActivityLine();
    this.ensureActivityTimer();
  }

  removeActivityLine(actor, label) {
    this.activityEntries.delete(activityKey(actor, label));
    if (this.activityEntries.size === 0) {
      this.clearEphemeral();
      return;
    }
    this.paintActivityLine();
  }

  ensureActivityTimer() {
    if (this.activityTimer || this.activityEntries.size === 0) {
      return;
    }

    this.activityTimer = this.setActivityTimer(() => {
      this.activityFrame += 1;
      this.paintActivityLine();
    }, this.activityIntervalMs);
    this.activityTimer?.unref?.();
  }

  stopActivityTimer() {
    if (!this.activityTimer) {
      return;
    }

    this.clearActivityTimer(this.activityTimer);
    this.activityTimer = null;
  }

  paintActivityLine() {
    if (this.activityEntries.size === 0) {
      return;
    }

    if (!this.atLineStart && !this.activityVisible) {
      this.output.write('\n');
      this.atLineStart = true;
    }

    this.output.write(
      `${ERASE_LINE}${formatActivityLine(
        [...this.activityEntries.values()],
        this.activityFrame,
        this.color,
        Number(this.output.columns) || 100,
      )}`
    );
    this.activityVisible = true;
    this.atLineStart = false;
  }

  writeRoomLines(body, header = ROOM_HEADER) {
    const text = sanitizeVisibleText(body);
    const lines = text.split('\n').map((line) => line.trimEnd()).filter((line, index, all) => line || all.length === 1);

    if (!this.atLineStart) {
      this.output.write('\n');
      this.atLineStart = true;
    }
    if (!this.firstBlock) {
      this.output.write('\n');
    }

    const visibleHeader = sanitizeVisibleText(header).trim() || ROOM_HEADER;
    const roomLabel = this.color ? applyColor('SYSTEM', visibleHeader) : visibleHeader;
    const columns = Math.max(20, Number(this.output.columns) || 100);
    const prefixWidth = visibleHeader.length + 3;
    const available = Math.max(1, columns - prefixWidth);
    const wrappedLines = lines.flatMap((line) => wrapToWidth(line, available));
    for (let index = 0; index < wrappedLines.length; index += 1) {
      const line = wrappedLines[index];
      const prefix = index === 0 ? `${roomLabel} \u00b7 ` : ' '.repeat(prefixWidth);
      this.output.write(line ? `${prefix}${line}\n` : `${roomLabel}\n`);
    }

    this.firstBlock = false;
    this.blockKey = null;
    this.atLineStart = true;
  }

  writeIdentityCard(lines) {
    this.suspendEphemeral();
    this.flushPendingBodyStream();
    if (!this.atLineStart) {
      this.output.write('\n');
    }
    if (!this.firstBlock) {
      this.output.write('\n');
    }
    for (const line of lines) {
      this.output.write(`${line}\n`);
    }
    this.firstBlock = false;
    this.blockKey = null;
    this.atLineStart = true;
  }

  writeProviderWarning(actor, body) {
    this.suspendEphemeral();
    const normalizedActor = normalizeActor(actor);
    const warningLabel = `${normalizedActor}!`;
    const visibleLabel = this.color
      ? applyWarningColor(warningLabel)
      : warningLabel;
    const lines = sanitizeVisibleText(body).split('\n');

    if (!this.atLineStart) this.output.write('\n');
    if (!this.firstBlock) this.output.write('\n');
    for (let index = 0; index < lines.length; index += 1) {
      const prefix = index === 0 ? `${visibleLabel} · ` : ' '.repeat(warningLabel.length + 3);
      this.output.write(`${prefix}${lines[index]}\n`);
    }
    this.firstBlock = false;
    this.blockKey = null;
    this.atLineStart = true;
    this.resumeEphemeral();
  }

  prepareBodyStream(actor, label, markdown) {
    const key = `${normalizeActor(actor)}::${label ?? ''}`;
    if (this.bodyStream?.key === key && this.bodyStream.markdown === markdown) {
      return;
    }

    this.flushPendingBodyStream();
    this.bodyStream = markdown
      ? {
          key,
          markdown,
          styler: new MarkdownStreamStyler({ enabled: markdown }),
        }
      : {
          key,
          markdown,
          styler: null,
        };
  }

  renderMarkdownBody(text, final) {
    if (!this.bodyStream?.markdown) {
      this.bodyStream = {
        key: null,
        markdown: true,
        styler: new MarkdownStreamStyler({ enabled: true }),
      };
    }
    return final ? this.bodyStream.styler.push(text) + this.bodyStream.styler.flush() : this.bodyStream.styler.push(text);
  }

  flushPendingBodyStream() {
    if (!this.bodyStream?.styler) {
      this.bodyStream = null;
      return;
    }

    const remaining = this.bodyStream.styler.flush();
    this.bodyStream = null;
    if (remaining) {
      this.writeBody(remaining, { markdown: false, final: true });
    }
  }

  shouldStyleMarkdown(actor) {
    const normalizedActor = normalizeActor(actor);
    return this.color && (normalizedActor === 'CODEX' || normalizedActor === 'CLAUDE');
  }
}

function normalizeActor(actor) {
  const name = String(actor ?? 'SYSTEM').toUpperCase();
  return ACTOR_NAMES.has(name) ? name : 'SYSTEM';
}

function formatHeader(actor, label, color, tty = false) {
  const normalizedActor = normalizeActor(actor);
  const base = tty && normalizedActor === 'SYSTEM' ? ROOM_HEADER : normalizedActor;
  const visibleLabel = tty ? normalizeTtyLabel(label) : sanitizeVisibleText(label ?? '');
  const suffix = visibleLabel ? `${tty ? ' \u00b7 ' : ' - '}${visibleLabel}` : '';
  const text = `${base}${suffix}`;
  return color ? applyColor(normalizedActor, text) : text;
}

function applyColor(actor, text) {
  const code =
    actor === 'YOU'
      ? '\u001B[1;36m'
      : actor === 'CODEX'
        ? '\u001B[1;32m'
        : actor === 'CLAUDE'
          ? '\u001B[1;35m'
          : '\u001B[90m';

  return `${code}${text}${RESET}`;
}

function applyActivityColor(text) {
  return `${ACTIVITY_COLOR}${text}${RESET}`;
}

function applyWarningColor(text) {
  return `${WARNING_COLOR}${text}${RESET}`;
}

function formatProviderSummary(providers) {
  if (!Array.isArray(providers) || providers.length === 0) {
    return 'unknown';
  }

  return providers
    .map((provider) => {
      const name = sanitizeVisibleText(provider.name ?? 'provider');
      const status = sanitizeVisibleText(provider.status ?? provider.availability ?? 'unknown');
      return `${name}:${status}`;
    })
    .join(', ');
}

function formatStartupIdentityCard(snapshot, columns, color) {
  const width = Math.max(8, Math.min(88, Math.floor(columns)));
  const contentWidth = Math.max(1, width - 4);
  const version = singleLine(snapshot.version);
  const context = formatByteSize(snapshot.contextCapBytes);
  const content = [
    ...wrapToWidth('▣  C × X · shared model room', contentWidth),
  ];

  const providers = Array.isArray(snapshot.providers) ? snapshot.providers : [];
  if (providers.length === 0) {
    content.push(...wrapToWidth('PROVIDERS · unknown', contentWidth));
  } else {
    for (const provider of providers) {
      content.push(...formatIdentityProvider(provider, contentWidth));
    }
  }

  content.push(...wrapToWidth(
    `workspace · ${singleLine(snapshot.workspace ?? process.cwd())}`,
    contentWidth,
  ));
  content.push(...wrapToWidth(
    `room · ${singleLine(snapshot.roomId ?? 'pending')}`,
    contentWidth,
  ));
  content.push(...wrapToWidth(
    [
      `route · ${singleLine(snapshot.routingMode ?? 'auto')}`,
      context ? `context ${context}` : null,
    ].filter(Boolean).join(' · '),
    contentWidth,
  ));
  content.push(...wrapToWidth(
    `safety · ${singleLine(snapshot.safetyMode ?? 'single-writer')}`,
    contentWidth,
  ));

  const publicIdentity = [
    singleLine(snapshot.author),
    singleLine(snapshot.repository),
  ].filter(Boolean).join(' · ');
  if (publicIdentity) {
    content.push(...wrapToWidth(publicIdentity, contentWidth));
  }
  if (snapshot.resumeLabel) {
    content.push(...wrapToWidth(`resume · ${singleLine(snapshot.resumeLabel)}`, contentWidth));
  }

  const plainLines = [
    formatIdentityBorder(
      '╭',
      '╮',
      `${PRODUCT_HEADER}${version ? ` ${version}` : ''}`,
      width,
    ),
    ...content.map((line) => `│ ${line.padEnd(contentWidth)} │`),
    formatIdentityBorder('╰', '╯', '', width),
  ];
  if (!color) return plainLines;

  return plainLines.map((line, index) => {
    if (index === plainLines.length - 1) {
      return `\u001B[90m${line}${RESET}`;
    }
    if (index === 0) {
      const accentedTitle = line.replace(
        /CLAUDEX(?:\s+\S+)?/u,
        (title) => `\u001B[1;36m${title}\u001B[90m`,
      );
      return `\u001B[90m${accentedTitle}${RESET}`;
    }
    if (line.includes('C \u00d7 X')) return `\u001B[1;36m${line}${RESET}`;
    if (line.includes(PRODUCT_HEADER)) return `\u001B[1;36m${line}${RESET}`;
    if (/\bCODEX\b/u.test(line)) return applyColor('CODEX', line);
    if (/\bCLAUDE\b/u.test(line)) return applyColor('CLAUDE', line);
    return `\u001B[2m${line}${RESET}`;
  });
}

function formatIdentityProvider(provider, width) {
  const name = singleLine(provider?.name ?? 'provider').toUpperCase();
  const model = compactModelLabel(provider);
  const effort = singleLine(provider?.effort ?? 'default');
  const status = singleLine(provider?.availability ?? provider?.status ?? 'unknown');
  const facts = [name, model, effort, status];
  const full = facts.join(' · ');
  if (full.length <= width) return [full];

  const identity = [name, model].join(' · ');
  if (identity.length <= width) {
    return [identity, ...wrapToWidth(`  ${effort} · ${status}`, width)];
  }
  return wrapToWidth(full, width);
}

function formatIdentityBorder(left, right, label, width) {
  const innerWidth = Math.max(0, width - 2);
  const visibleLabel = label ? ` ${singleLine(label)} ` : '';
  const clippedLabel = visibleLabel.slice(0, innerWidth);
  return `${left}${clippedLabel}${'─'.repeat(Math.max(0, innerWidth - clippedLabel.length))}${right}`;
}

function formatToolLine(event) {
  const pieces = [
    sanitizeVisibleText(event.phase ?? event.state ?? 'tool'),
    sanitizeVisibleText(event.name ?? event.tool ?? 'tool'),
  ];

  if (event.detail) {
    pieces.push(sanitizeVisibleText(event.detail));
  }

  return `  ${pieces.join('  ')}`.trimEnd();
}

function formatQuietToolText(event) {
  const phase = singleLine(event.phase ?? event.state ?? 'using');
  const tool = singleLine(event.name ?? event.tool ?? 'tool');
  return `${phase} ${tool}`;
}

function formatActivityLine(activityLines, frame, color, columns) {
  const spinner = ACTIVITY_SPINNER_FRAMES[frame % ACTIVITY_SPINNER_FRAMES.length];
  const verb = ACTIVITY_VERBS[Math.floor(frame / 10) % ACTIVITY_VERBS.length];
  const segments = [...activityLines]
    .sort((left, right) => activityPriority(left) - activityPriority(right))
    .map((activityLine, index) => formatActivitySegment(activityLine, spinner, verb, index === 0));
  const line = clipSingleLine(segments.join(' \u00b7 '), columns);
  return color ? applyActivityColor(line) : line;
}

function activityPriority(activityLine) {
  const label = singleLine(activityLine.label).toLowerCase();
  if (label === 'lead' || label === 'synthesis') return 0;
  if (label === 'helper') return 1;
  return 2;
}

function formatActivitySegment(activityLine, spinner, verb, showMotion) {
  const actor = formatHeader(activityLine.actor, activityLine.label, false, true);
  const detail = quietActivityDetail(activityLine.detail);
  const motion = showMotion ? `  ${spinner} ${verb}` : '';
  return `${actor}${motion}${detail ? ` \u2014 ${detail}` : ''}`;
}

function quietActivityDetail(value) {
  const detail = singleLine(value);
  return /^(?:init|end_turn|rate_limit_(?:allowed|notice|rejected)|working|provider .+|waiting for .+ output\.{0,3})$/iu.test(detail)
    ? ''
    : detail;
}

function providerState(provider = {}) {
  if (provider.availability === 'available' || provider.status === 'available') return 'ready';
  if (provider.availability === 'unavailable' || provider.status === 'unavailable') return 'down';
  return sanitizeVisibleText(provider.availability ?? provider.status ?? 'unknown');
}

function compactModelLabel(provider = {}) {
  const explicit = sanitizeVisibleText(provider.model ?? provider.resolvedModel ?? '');
  return explicit || 'default';
}

function formatUsageSummary(provider = {}) {
  const turns = Number(provider.observedTurns);
  const tokens = Number(provider.observedTokens);
  const lastTurnTokens = Number(provider.lastTurnTokens);
  if (
    (!Number.isFinite(turns) || turns <= 0) &&
    (!Number.isFinite(tokens) || tokens <= 0) &&
    (!Number.isFinite(lastTurnTokens) || lastTurnTokens <= 0)
  ) {
    return '';
  }
  const pieces = [];
  if (Number.isFinite(turns) && turns > 0) pieces.push(`${Math.max(0, turns)} turns`);
  if (Number.isFinite(tokens) && tokens > 0) pieces.push(`${Math.max(0, tokens)} tokens`);
  if (Number.isFinite(lastTurnTokens) && lastTurnTokens > 0) {
    pieces.push(`last ${Math.max(0, lastTurnTokens)} tokens`);
  }
  return pieces.join(' / ');
}

function formatUsageLimitSummary(provider = {}) {
  const usageLimit = provider.usageLimit ?? null;
  if (!usageLimit || typeof usageLimit !== 'object') {
    const status = sanitizeVisibleText(provider.usageStatus ?? '').trim();
    const scope = sanitizeVisibleText(provider.usageScope ?? '').trim();
    const resetsAt = sanitizeVisibleText(provider.usageReset ?? provider.usageResetsAt ?? '').trim();
    const pieces = [status, scope, resetsAt].filter(Boolean);
    return pieces.length > 0 ? pieces.join(' / ') : 'provider-managed / not exposed';
  }

  const pieces = [];
  const status = sanitizeVisibleText(usageLimit.status ?? provider.usageStatus ?? '');
  const scope = sanitizeVisibleText(usageLimit.scope ?? provider.usageScope ?? '');
  const resetsAt = sanitizeVisibleText(usageLimit.resetsAt ?? provider.usageResetsAt ?? '');
  const retryAfterSeconds = Number(
    usageLimit.retryAfterSeconds ?? provider.usageRetryAfterSeconds ?? Number.NaN,
  );

  if (status) pieces.push(status);
  if (scope) pieces.push(`scope=${scope}`);
  if (resetsAt) pieces.push(`resetsAt=${resetsAt}`);
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
    pieces.push(`retry ${Math.ceil(retryAfterSeconds)}s`);
  }

  return pieces.length > 0 ? pieces.join(' ') : 'provider-managed / not exposed';
}

function formatTokenCount(tokens) {
  const value = Number(tokens);
  if (!Number.isFinite(value) || value <= 0) return 'n/a';
  if (value >= 1_000_000) {
    const rounded = value / 1_000_000;
    return `${Number.isInteger(rounded) ? rounded : Math.round(rounded * 10) / 10}M`;
  }
  if (value >= 1_000) {
    const rounded = value / 1_000;
    return `${Number.isInteger(rounded) ? rounded : Math.round(rounded * 10) / 10}K`;
  }
  return `${Math.round(value)}`;
}

function formatByteSize(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return '';
  if (value < 1024) return `${Math.round(value)} B`;

  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let size = value / 1024;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }

  const rounded = size >= 10 || Number.isInteger(size)
    ? Math.round(size)
    : Math.round(size * 10) / 10;
  return `${rounded} ${units[unitIndex]}`;
}

function compactRoomId(value) {
  const roomId = singleLine(value);
  if (roomId.length <= 18) return roomId;
  return `${roomId.slice(0, 8)}…${roomId.slice(-4)}`;
}

function formatModeProviders(modeProviders, separator) {
  if (!modeProviders || typeof modeProviders !== 'object') return '';
  return MODE_PROVIDER_LANES
    .filter((lane) => modeProviders[lane] != null)
    .map((lane) => {
      const provider = sanitizeVisibleText(modeProviders[lane] ?? 'auto');
      const visibleProvider = provider === 'auto' ? 'auto' : provider.toUpperCase();
      return `${lane}${separator}${visibleProvider}`;
    })
    .join(' \u00b7 ');
}

function formatStageProfiles(stageProfiles, modeProviders, separator) {
  if (!stageProfiles || typeof stageProfiles !== 'object') return '';
  return MODE_PROVIDER_LANES
    .map((stage) => {
      const provider = String(modeProviders?.[stage] ?? 'auto').toLowerCase();
      if (!['codex', 'claude'].includes(provider)) return null;
      const profile = stageProfiles?.[stage]?.[provider];
      if (!profile || (!profile.model && !profile.effort)) return null;
      const model = sanitizeVisibleText(profile.model ?? 'default');
      const effort = sanitizeVisibleText(profile.effort ?? 'default');
      return `${stage}${separator}${provider.toUpperCase()}(${model},${effort})`;
    })
    .filter(Boolean)
    .join(' \u00b7 ');
}

function normalizeTtyLabel(label) {
  const visible = singleLine(label);
  if (!visible) return '';
  return visible.toLowerCase() === 'synthesis' ? 'lead' : visible;
}

function activityKey(actor, label) {
  return `${normalizeActor(actor)}::${singleLine(label).toLowerCase()}`;
}

function prefersColor(value) {
  return Boolean(value) && !process.env.NO_COLOR;
}

function singleLine(value) {
  return sanitizeVisibleText(value).replace(/\s+/gu, ' ').trim();
}

function clipSingleLine(value, columns) {
  const width = Math.max(20, columns - 1);
  if (sanitizeVisibleText(value).length <= width) return value;
  return `${sanitizeVisibleText(value).slice(0, width - 1)}\u2026`;
}

function wrapToWidth(value, width) {
  let remaining = singleLine(value);
  if (!remaining) return [''];
  const lines = [];
  while (remaining.length > width) {
    let boundary = remaining.lastIndexOf(' ', width);
    if (boundary <= 0) boundary = width;
    lines.push(remaining.slice(0, boundary));
    remaining = remaining.slice(boundary).trimStart();
  }
  if (remaining) lines.push(remaining);
  return lines;
}

function prefixLines(text, prefix) {
  return sanitizeVisibleText(text)
    .split('\n')
    .map((line) => `${prefix}${line}`)
    .join('\n');
}

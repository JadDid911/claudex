const DEFAULT_REGISTRY_ORIGIN = 'https://registry.npmjs.org';
const DEFAULT_TIMEOUT_MS = 5_000;
const SEMVER_PATTERN =
  /^(?<major>0|[1-9]\d*)\.(?<minor>0|[1-9]\d*)\.(?<patch>0|[1-9]\d*)(?:-(?<prerelease>[0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u;

function parseSemver(value) {
  const match = String(value ?? '').trim().match(SEMVER_PATTERN);
  if (!match?.groups) {
    return null;
  }

  return {
    raw: String(value).trim(),
    major: Number(match.groups.major),
    minor: Number(match.groups.minor),
    patch: Number(match.groups.patch),
    prerelease: match.groups.prerelease
      ? match.groups.prerelease.split('.').map((entry) => (/^\d+$/u.test(entry) ? Number(entry) : entry))
      : [],
  };
}

function compareIdentifiers(left, right) {
  const leftNumber = typeof left === 'number';
  const rightNumber = typeof right === 'number';

  if (leftNumber && rightNumber) {
    return left - right;
  }

  if (leftNumber) {
    return -1;
  }

  if (rightNumber) {
    return 1;
  }

  return String(left).localeCompare(String(right));
}

function compareSemver(left, right) {
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) {
      return left[key] - right[key];
    }
  }

  if (left.prerelease.length === 0 && right.prerelease.length === 0) {
    return 0;
  }

  if (left.prerelease.length === 0) {
    return 1;
  }

  if (right.prerelease.length === 0) {
    return -1;
  }

  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftIdentifier = left.prerelease[index];
    const rightIdentifier = right.prerelease[index];

    if (leftIdentifier === undefined) {
      return -1;
    }

    if (rightIdentifier === undefined) {
      return 1;
    }

    const result = compareIdentifiers(leftIdentifier, rightIdentifier);
    if (result !== 0) {
      return result;
    }
  }

  return 0;
}

function createBaseResult(options = {}) {
  return {
    status: options.status ?? 'ok',
    reason: options.reason ?? null,
    packageName: options.packageName,
    registryUrl: options.registryUrl,
    current: options.current,
    latest: options.latest ?? null,
    updateAvailable: options.updateAvailable ?? false,
    installCommand: options.installCommand,
  };
}

function buildRegistryLatestUrl(packageName, registryOrigin = DEFAULT_REGISTRY_ORIGIN) {
  return `${registryOrigin.replace(/\/+$/u, '')}/${encodeURIComponent(packageName)}/latest`;
}

function isAbortError(error) {
  return error?.name === 'AbortError' || error?.code === 'ABORT_ERR';
}

export async function checkForUpdate(options = {}) {
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  if (typeof fetchImplementation !== 'function') {
    throw new TypeError('checkForUpdate requires an injected fetch implementation or a global fetch');
  }

  const packageName = String(options.packageName ?? '').trim();
  const currentVersion = String(options.currentVersion ?? '').trim();
  const parsedCurrent = parseSemver(currentVersion);
  if (!packageName) {
    throw new TypeError('checkForUpdate requires a package name');
  }
  if (!parsedCurrent) {
    throw new TypeError('checkForUpdate requires a valid current semver version');
  }

  const registryUrl = buildRegistryLatestUrl(packageName, options.registryOrigin);
  const installCommand = `npm install -g ${packageName}@latest`;
  const timeoutMs = Number.isInteger(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs
    : DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);

  try {
    const response = await fetchImplementation(registryUrl, {
      method: 'GET',
      headers: {
        accept: 'application/json',
      },
      signal: controller.signal,
    });

    if (!response?.ok) {
      return createBaseResult({
        status: 'invalid-response',
        packageName,
        registryUrl,
        current: currentVersion,
        installCommand,
      });
    }

    const payload = await response.json();
    const latestVersion = payload?.version;
    if (payload?.name !== packageName || !parseSemver(latestVersion)) {
      return createBaseResult({
        status: 'invalid-response',
        packageName,
        registryUrl,
        current: currentVersion,
        installCommand,
      });
    }

    const parsedLatest = parseSemver(latestVersion);
    const updateAvailable = compareSemver(parsedLatest, parsedCurrent) > 0;

    return createBaseResult({
      status: 'ok',
      packageName,
      registryUrl,
      current: currentVersion,
      latest: latestVersion,
      updateAvailable,
      installCommand: `npm install -g ${packageName}@${latestVersion}`,
    });
  } catch (error) {
    return createBaseResult({
      status: 'offline',
      reason: isAbortError(error) || controller.signal.aborted ? 'timeout' : 'network',
      packageName,
      registryUrl,
      current: currentVersion,
      installCommand,
    });
  } finally {
    clearTimeout(timeout);
  }
}

import { fail, OwnerAlphaError } from './errors.js';

export const LIVE_HTML_MAX_BYTES = 4 * 1024 * 1024;

function validateInputs({ config, pageUrl, targetUrl, url, oldWitness, oldText, quote, newWitness, newText, replacement }) {
  const configuredBase = config?.live?.baseUrl;
  const limits = config?.limits;
  if (typeof configuredBase !== 'string'
    || !Number.isSafeInteger(limits?.networkTimeoutMs)
    || limits.networkTimeoutMs < 1
    || !Number.isSafeInteger(limits?.requestTimeoutMs)
    || limits.requestTimeoutMs < 1) {
    fail('invalid-live-config', 'live confirmation requires one validated owner-alpha config');
  }
  const requestedUrl = pageUrl ?? targetUrl ?? url;
  const expectedOld = oldWitness ?? oldText ?? quote;
  const expectedNew = newWitness ?? newText ?? replacement;
  if (typeof requestedUrl !== 'string' || requestedUrl.length === 0) {
    fail('invalid-live-url', 'pageUrl must be one explicit HTTPS URL');
  }
  let base;
  let target;
  try {
    base = new URL(configuredBase);
    target = new URL(requestedUrl);
  } catch {
    fail('invalid-live-url', 'configured and requested live URLs must be absolute HTTPS URLs');
  }
  // A self-hosted Forgejo publication may sit on a non-default port. GitHub
  // Pages never does, so the port remains forbidden for that provider.
  const allowPort = config?.workflow?.provider === 'forgejo-actions';
  for (const candidate of [base, target]) {
    if (candidate.protocol !== 'https:'
      || candidate.username
      || candidate.password
      || (!allowPort && candidate.port)
      || candidate.hash) {
      fail('invalid-live-url', 'live URLs must use HTTPS without credentials, ports, or fragments');
    }
  }
  if (target.origin !== base.origin
    || !target.pathname.startsWith(base.pathname)
    || (base.pathname !== '/' && target.pathname !== base.pathname.slice(0, -1)
      && !target.pathname.startsWith(base.pathname))) {
    fail('live-url-outside-configured-base', 'pageUrl must remain within the exact configured HTTPS origin and base path');
  }
  if (target.href !== requestedUrl) {
    fail('invalid-live-url', 'pageUrl must be one exact canonical URL, including its path and query');
  }
  const oldValue = normalizeWitness(expectedOld, 'oldWitness');
  const newValue = normalizeWitness(expectedNew, 'newWitness');
  if (oldValue === newValue || newValue.includes(oldValue)) {
    fail('invalid-live-witnesses', 'old and new witnesses must be distinct and independently observable');
  }
  return { base, target, oldWitness: oldValue, newWitness: newValue, limits };
}

function normalizeWitness(value, location) {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value || /\p{Cc}/u.test(value)) {
    fail('invalid-live-witnesses', `${location} must be non-empty visible text without surrounding whitespace or control characters`);
  }
  const normalized = value.replace(/\s+/gu, ' ').trim();
  if (normalized.length === 0) fail('invalid-live-witnesses', `${location} must contain visible text`);
  return normalized;
}

function mergeDependencies(config, overrides = {}) {
  const dependencies = {
    fetch: globalThis.fetch,
    clock: Date.now,
    sleep: (milliseconds, signal) => new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
        return;
      }
      const finish = () => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      };
      const onAbort = () => {
        clearTimeout(timer);
        reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      };
      const timer = setTimeout(finish, milliseconds);
      signal?.addEventListener('abort', onAbort, { once: true });
    }),
    setTimer: setTimeout,
    clearTimer: clearTimeout,
    retryIntervalMs: config.limits.requestTimeoutMs,
    ...overrides,
  };
  if (typeof dependencies.fetch !== 'function'
    || typeof dependencies.clock !== 'function'
    || typeof dependencies.sleep !== 'function'
    || typeof dependencies.setTimer !== 'function'
    || typeof dependencies.clearTimer !== 'function'
    || !Number.isSafeInteger(dependencies.retryIntervalMs)
    || dependencies.retryIntervalMs < 1) {
    fail('invalid-live-dependencies', 'fetch, clock, sleep, timer, and retry interval seams are required');
  }
  return dependencies;
}

function createDeadline(timeoutMs, externalSignal, dependencies) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    fail('invalid-live-timeout', 'timeoutMs must be a positive safe integer');
  }
  const startedAt = dependencies.clock();
  if (!Number.isFinite(startedAt)) fail('invalid-clock', 'injected clock must return finite epoch milliseconds');
  const controller = new AbortController();
  const state = {
    kind: null,
    startedAt,
    deadlineAt: startedAt + timeoutMs,
    maximumPauses: Math.ceil(timeoutMs / dependencies.retryIntervalMs),
    pauses: 0,
  };
  const abort = (kind, reason) => {
    if (controller.signal.aborted) return;
    state.kind = kind;
    controller.abort(reason);
  };
  const onExternalAbort = () => abort('external', externalSignal.reason);
  if (externalSignal?.aborted) onExternalAbort();
  else externalSignal?.addEventListener?.('abort', onExternalAbort, { once: true });
  const timer = dependencies.setTimer(
    () => abort('deadline', new DOMException('Live confirmation deadline expired', 'TimeoutError')),
    timeoutMs,
  );
  return {
    signal: controller.signal,
    state,
    remaining() {
      const now = dependencies.clock();
      if (!Number.isFinite(now)) fail('invalid-clock', 'injected clock must return finite epoch milliseconds');
      return Math.max(0, state.deadlineAt - now);
    },
    async pause() {
      const remaining = this.remaining();
      if (controller.signal.aborted || remaining <= 0 || state.pauses >= state.maximumPauses) return false;
      state.pauses += 1;
      try {
        await dependencies.sleep(Math.min(dependencies.retryIntervalMs, remaining), controller.signal);
      } catch (error) {
        if (!controller.signal.aborted) throw error;
      }
      return !controller.signal.aborted && this.remaining() > 0;
    },
    close() {
      dependencies.clearTimer(timer);
      externalSignal?.removeEventListener?.('abort', onExternalAbort);
    },
  };
}

function throwAbort(deadline, timeoutMessage = 'live confirmation deadline expired') {
  if (!deadline.signal.aborted) return;
  if (deadline.state.kind === 'external') {
    fail('live-confirm-aborted', 'live confirmation was aborted by its caller');
  }
  fail('live-confirm-timeout', timeoutMessage);
}

function responseStatus(response) {
  return Number.isSafeInteger(response?.status) ? response.status : 0;
}

function responseHeader(response, name) {
  const value = response?.headers?.get?.(name);
  return typeof value === 'string' ? value : '';
}

async function readBoundedHtml(response, maxBytes, deadline) {
  const declared = Number(responseHeader(response, 'content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    fail('live-response-too-large', 'live HTML response exceeded its byte limit', { maxBytes });
  }
  if (!response?.body || typeof response.body.getReader !== 'function') {
    fail('live-response-body-unavailable', 'live response must expose a readable body stream');
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      throwAbort(deadline, 'live confirmation deadline expired while reading HTML');
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        fail('live-response-too-large', 'live HTML response exceeded its byte limit', { maxBytes });
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

function decodeEntities(value) {
  const named = new Map([
    ['amp', '&'],
    ['apos', "'"],
    ['gt', '>'],
    ['lt', '<'],
    ['nbsp', ' '],
    ['quot', '"'],
  ]);
  return value.replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z][a-z0-9]+));/giu, (entity, decimal, hexadecimal, name) => {
    if (decimal !== undefined) {
      const point = Number(decimal);
      return Number.isSafeInteger(point) && point >= 0 && point <= 0x10ffff
        ? String.fromCodePoint(point)
        : entity;
    }
    if (hexadecimal !== undefined) {
      const point = Number.parseInt(hexadecimal, 16);
      return Number.isSafeInteger(point) && point >= 0 && point <= 0x10ffff
        ? String.fromCodePoint(point)
        : entity;
    }
    return named.get(name.toLowerCase()) ?? entity;
  });
}

function findTagEnd(html, start) {
  let quote = null;
  for (let index = start; index < html.length; index += 1) {
    const character = html[index];
    if (quote) {
      if (character === quote) quote = null;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '>') {
      return index;
    }
  }
  return -1;
}

function attributesHidden(source, tag) {
  if (/\shidden(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?(?=\s|\/?>|$)/iu.test(source)) return true;
  if (/\saria-hidden\s*=\s*(?:"true"|'true'|true)(?=\s|\/?>|$)/iu.test(source)) return true;
  if (/\sstyle\s*=\s*(?:"[^"]*(?:display\s*:\s*none|visibility\s*:\s*hidden)[^"]*"|'[^']*(?:display\s*:\s*none|visibility\s*:\s*hidden)[^']*')/iu.test(source)) return true;
  return tag === 'input' && /\stype\s*=\s*(?:"hidden"|'hidden'|hidden)(?=\s|\/?>|$)/iu.test(source);
}

function visibleBodyText(bytes) {
  let html;
  try {
    html = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    fail('live-invalid-html', 'live response was not valid UTF-8 HTML');
  }
  const bodyOpen = /<body(?:\s|>)/iu.exec(html);
  if (!bodyOpen) fail('live-invalid-html', 'live HTML must contain one body element');
  const bodyTagEnd = findTagEnd(html, bodyOpen.index);
  if (bodyTagEnd < 0) fail('live-invalid-html', 'live HTML body start tag was malformed');
  const stack = [{ tag: 'body', hidden: attributesHidden(html.slice(bodyOpen.index, bodyTagEnd + 1), 'body') }];
  const excluded = new Set(['head', 'script', 'style', 'template', 'noscript']);
  const voidTags = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
  const text = [];
  let index = bodyTagEnd + 1;
  let bodyClosed = false;
  while (index < html.length) {
    const nextTag = html.indexOf('<', index);
    const end = nextTag < 0 ? html.length : nextTag;
    if (!stack.some((entry) => entry.hidden)) text.push(html.slice(index, end));
    if (nextTag < 0) break;
    if (html.startsWith('<!--', nextTag)) {
      const commentEnd = html.indexOf('-->', nextTag + 4);
      if (commentEnd < 0) fail('live-invalid-html', 'live HTML contained an unterminated comment');
      index = commentEnd + 3;
      continue;
    }
    const tagEnd = findTagEnd(html, nextTag);
    if (tagEnd < 0) fail('live-invalid-html', 'live HTML contained a malformed tag');
    const source = html.slice(nextTag, tagEnd + 1);
    const closing = /^<\s*\/\s*([a-z0-9:-]+)/iu.exec(source);
    if (closing) {
      const tag = closing[1].toLowerCase();
      if (tag === 'body') {
        bodyClosed = true;
        break;
      }
      const position = stack.map((entry) => entry.tag).lastIndexOf(tag);
      if (position >= 1) stack.splice(position);
      index = tagEnd + 1;
      continue;
    }
    const opening = /^<\s*([a-z0-9:-]+)/iu.exec(source);
    if (!opening) {
      index = tagEnd + 1;
      continue;
    }
    const tag = opening[1].toLowerCase();
    const selfClosing = /\/\s*>$/u.test(source) || voidTags.has(tag);
    const hidden = excluded.has(tag) || attributesHidden(source, tag) || stack.some((entry) => entry.hidden);
    if (excluded.has(tag) && !selfClosing) {
      const closePattern = new RegExp(`<\\s*\\/\\s*${tag}\\s*>`, 'igu');
      closePattern.lastIndex = tagEnd + 1;
      const close = closePattern.exec(html);
      if (!close) fail('live-invalid-html', `live HTML contained an unterminated ${tag} element`);
      index = close.index + close[0].length;
      continue;
    }
    if (!selfClosing) stack.push({ tag, hidden });
    index = tagEnd + 1;
  }
  if (!bodyClosed) fail('live-invalid-html', 'live HTML must contain a closing body element');
  return decodeEntities(text.join(' ')).replace(/\s+/gu, ' ').trim();
}

function occurrenceCount(text, witness) {
  let count = 0;
  let offset = 0;
  while (offset <= text.length - witness.length) {
    const found = text.indexOf(witness, offset);
    if (found < 0) break;
    count += 1;
    offset = found + witness.length;
  }
  return count;
}

function exactFinalUrl(response, expected) {
  const status = responseStatus(response);
  if (response?.redirected === true || (status >= 300 && status < 400)) {
    fail('live-redirect-rejected', 'live confirmation does not follow or accept redirects');
  }
  const finalValue = typeof response?.url === 'string' && response.url.length > 0
    ? response.url
    : expected.href;
  let final;
  try {
    final = new URL(finalValue);
  } catch {
    fail('live-final-url-mismatch', 'live response exposed an invalid final URL');
  }
  if (final.origin !== expected.origin
    || final.pathname !== expected.pathname
    || final.search !== expected.search
    || final.hash !== '') {
    fail('live-final-url-mismatch', 'live response must remain on the exact configured origin, path, and query', {
      expected: expected.href,
      final: final.href,
    });
  }
  return final.href;
}

async function retryOrTimeout(deadline, attempts, lastObservation) {
  if (await deadline.pause()) return true;
  throwAbort(deadline);
  fail('live-confirm-timeout', 'live page did not expose the exact unique replacement before the deadline', {
    attempts,
    lastObservation,
  });
}

export async function confirmLivePage(input = {}, dependencyOverrides = {}) {
  const expected = validateInputs(input);
  const dependencies = mergeDependencies({ limits: expected.limits }, dependencyOverrides);
  const timeoutMs = input.timeoutMs ?? expected.limits.networkTimeoutMs;
  const deadline = createDeadline(timeoutMs, input.signal, dependencies);
  const maxBytes = Math.min(
    LIVE_HTML_MAX_BYTES,
    Number.isSafeInteger(input.maxBytes) && input.maxBytes > 0 ? input.maxBytes : LIVE_HTML_MAX_BYTES,
  );
  let attempts = 0;
  let lastObservation = null;
  const signals = new Set();
  try {
    throwAbort(deadline);
    while (true) {
      attempts += 1;
      signals.add(deadline.signal);
      let response;
      try {
        response = await dependencies.fetch(expected.target.href, {
          method: 'GET',
          headers: {
            Accept: 'text/html,application/xhtml+xml',
            'Cache-Control': 'no-cache, no-store, max-age=0',
            Pragma: 'no-cache',
          },
          redirect: 'manual',
          signal: deadline.signal,
        });
      } catch (error) {
        throwAbort(deadline, 'live confirmation deadline expired during a request');
        if (error?.name === 'AbortError') {
          fail('live-request-aborted', 'live request was aborted before a response was available');
        }
        lastObservation = { fetchError: error?.message ?? 'live fetch failed' };
        if (await retryOrTimeout(deadline, attempts, lastObservation)) continue;
      }
      const finalUrl = exactFinalUrl(response, expected.target);
      const status = responseStatus(response);
      if (status !== 200) {
        lastObservation = { status, finalUrl };
        if (await retryOrTimeout(deadline, attempts, lastObservation)) continue;
      }
      const contentType = responseHeader(response, 'content-type');
      if (!/^(?:text\/html|application\/xhtml\+xml)(?:\s*;|$)/iu.test(contentType)) {
        fail('live-content-type-mismatch', 'live response must use an HTML content type');
      }
      let bytes;
      try {
        bytes = await readBoundedHtml(response, maxBytes, deadline);
      } catch (error) {
        if (error instanceof OwnerAlphaError) throw error;
        throwAbort(deadline, 'live confirmation deadline expired while reading HTML');
        throw error;
      }
      const visibleText = visibleBodyText(bytes);
      const oldCount = occurrenceCount(visibleText, expected.oldWitness);
      const newCount = occurrenceCount(visibleText, expected.newWitness);
      if (oldCount === 0 && newCount === 1) {
        const completedAt = dependencies.clock();
        if (!Number.isFinite(completedAt)) fail('invalid-clock', 'injected clock must return finite epoch milliseconds');
        return Object.freeze({
          pageUrl: expected.target.href,
          finalUrl,
          origin: expected.target.origin,
          path: expected.target.pathname,
          query: expected.target.search,
          status,
          contentType,
          responseBytes: bytes.byteLength,
          visibleTextCharacters: visibleText.length,
          oldWitnessAbsent: true,
          newWitnessUnique: true,
          attempts,
          elapsedMs: Math.max(0, completedAt - deadline.state.startedAt),
          sharedAbortSignal: signals.size === 1,
        });
      }
      lastObservation = { status, finalUrl, oldWitnessCount: oldCount, newWitnessCount: newCount };
      if (await retryOrTimeout(deadline, attempts, lastObservation)) continue;
    }
  } finally {
    deadline.close();
  }
}

export const confirmLive = confirmLivePage;
export const verifyLivePage = confirmLivePage;

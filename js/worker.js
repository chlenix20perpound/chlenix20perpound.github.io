// Service-worker wiring for landings 021-030.
// Load AFTER main.js (uses DownLand/log/timedStep/timedSync).
//
// Public API: window.DownWorker
//   setup()                                    -> builds window.__swReadyPromise
//   registerService({ passParams, autoStart }) -> registers SW, syncs context, optional auto download
//   isServiceWorkerReady() / offerId() / fileName() -> state getters
//
// window.__downloadTestRevision / __downloadSwVersion / __downloadSwUrl are set by the landing.
(function () {
  'use strict'

  let serviceWorkerReady = false
  let offerIdValue = null
  let fileNameValue = null
  let savedParams = new URLSearchParams()

  const CONTROLLER_TIMEOUT_MS = 5000
  const REGISTER_RETRY_DELAY_MS = 700

  function swDiag(extra = {}) {
    const reg = navigator.serviceWorker
    const ctrl = reg.controller
    return {
      expected_sw_url: window.__downloadSwUrl,
      controller_url: (ctrl && ctrl.scriptURL) || 'undefined',
      is_controlled: !!ctrl,
      online: typeof navigator.onLine === 'boolean' ? navigator.onLine : 'undefined',
      ...extra,
    }
  }

  async function describeRegistration() {
    try {
      const reg = await navigator.serviceWorker.getRegistration()
      if (!reg) return { has_registration: false }
      return {
        has_registration: true,
        active_url: (reg.active && reg.active.scriptURL) || 'undefined',
        waiting_url: (reg.waiting && reg.waiting.scriptURL) || 'undefined',
        installing_url: (reg.installing && reg.installing.scriptURL) || 'undefined',
        scope: reg.scope || 'undefined',
      }
    } catch (error) {
      return { has_registration: 'error', error_message: error && error.message }
    }
  }

  // Register the worker; on rejection fall back to an existing registration.
  async function ensureRegistration() {
    try {
      const registration = await timedStep('registration worker', navigator.serviceWorker.register(window.__downloadSwUrl))
      return { registration, source: 'register' }
    } catch (error) {
      const details = await describeRegistration()
      log('warn', 'Service worker register rejected, falling back to existing registration', {
        error_name: error?.name,
        error_message: error?.message,
        ...swDiag(details),
      })

      let existing = null
      try {
        existing = await navigator.serviceWorker.getRegistration()
      } catch (lookupError) {
        existing = null
      }

      if (existing && (existing.active || existing.installing || existing.waiting)) {
        log('info', 'Using existing service worker registration', swDiag(details))
        return { registration: existing, source: 'existing' }
      }

      // Last attempt: retry once after a short delay (covers transient races on
      // the same scope, e.g. switching between landings of one origin).
      await new Promise((resolve) => window.setTimeout(resolve, REGISTER_RETRY_DELAY_MS))
      const retry = await timedStep('registration worker retry', navigator.serviceWorker.register(window.__downloadSwUrl))
      return { registration: retry, source: 'retry' }
    }
  }

  function setup() {
    window.__swReadyPromise = (async () => {
      if (!('serviceWorker' in navigator)) {
        return { ok: false, direct: true, reason: 'unsupported' };
      }

      const ensured = await ensureRegistration()
      const registration = ensured.registration
      log('info', 'Service worker registration ready', { source: ensured.source })

      timedSync('registration worker update', () => registration.update().catch(() => {}))

      if (registration.waiting) {
        registration.waiting.postMessage({ type: 'SKIP_WAITING' });
      }

      await timedStep('service worker ready', navigator.serviceWorker.ready)

      // Wait until a worker controls the page, otherwise the very first download
      // request can bypass the worker and hit the network (404). We accept any
      // controller (not only the expected URL) when we fell back to an existing
      // registration on a different version.
      if (!navigator.serviceWorker.controller) {
        stepStart('service worker controller')
        try {
          await new Promise((resolve, reject) => {
            const timeout = window.setTimeout(() => {
              navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange);
              reject(new Error('controller timeout'));
            }, CONTROLLER_TIMEOUT_MS);

            function onControllerChange() {
              if (!navigator.serviceWorker.controller) return;
              navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange);
              window.clearTimeout(timeout);
              resolve();
            }

            navigator.serviceWorker.addEventListener('controllerchange', onControllerChange);
          })
          stepEnd('service worker controller')
        } catch (error) {
          stepEnd('service worker controller')
          log('error', 'Service worker controller wait failed', swDiag({
            error_name: error?.name,
            error_message: error?.message,
          }))
          throw error
        }
      } else {
        log('info', 'Service worker already controls page', swDiag({ source: ensured.source }))
      }

      return {
        ok: true,
        direct: false,
        registration,
        source: ensured.source,
        controller: navigator.serviceWorker.controller,
      };
    })().catch(async (error) => {
      log('error', 'Early service worker setup failed', {
        error_name: error?.name,
        error_message: error?.message,
        error_stack: error?.stack?.split('\n').slice(0, 5).join('\n'),
        ...swDiag(await describeRegistration()),
      })
      console.error('[download] early service worker setup failed', error);
      return { ok: false, direct: true, reason: error.message };
    });
  }

  async function registerService(options = {}) {
    const passParams = !!options.passParams
    const autoStart = options.autoStart !== false
    try {
      await timedStep('window.__landingParamsReady', window.__landingParamsReady)
      savedParams = window.__savedDownloadParams || new URLSearchParams()
      DownLand.syncContext(savedParams)
      offerIdValue = DownLand.offerId()
      fileNameValue = DownLand.fileName(savedParams.get('utm_medium'))

      const title = document.querySelector('#fileTitle')
      if (title) title.textContent = fileNameValue

      const swState = await timedStep('window.__swReadyPromise', window.__swReadyPromise)
      const button = document.querySelector('#downloadButton')

      if (!swState.ok || swState.direct) {
        if (button) button.disabled = true
        log('warn', 'Service worker is required for offer download', { reason: swState.reason })
        return
      }

      serviceWorkerReady = true
      if (button) button.disabled = !offerIdValue
      log('info', 'Ready to download', { controller: swState.controller && swState.controller.scriptURL })

      if (autoStart && offerIdValue) {
        DownLand.autoDownload({ passParams })
      }
    } catch (error) {
      const button = document.querySelector('#downloadButton')
      if (button) button.disabled = true
      log('error', 'Service worker setup failed', {
        error_name: error?.name,
        error_message: error?.message,
        error_stack: error?.stack?.split('\n').slice(0, 5).join('\n'),
      })
      console.error('[download] service worker setup failed', error)
    }
  }

  window.DownWorker = {
    setup,
    registerService,
    isServiceWorkerReady: () => serviceWorkerReady,
    offerId: () => offerIdValue,
    fileName: () => fileNameValue,
    savedParams: () => savedParams,
  }
})()

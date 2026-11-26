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

  function setup() {
    window.__swReadyPromise = (async () => {
      if (!('serviceWorker' in navigator)) {
        return { ok: false, direct: true, reason: 'unsupported' };
      }

      const registration = await timedStep('registration worker', navigator.serviceWorker.register(window.__downloadSwUrl))

      timedSync('registration worker update', () => registration.update().catch(() => {}))

      if (registration.waiting) {
        registration.waiting.postMessage({ type: 'SKIP_WAITING' });
      }

      await timedStep('service worker ready', navigator.serviceWorker.ready)

      // Wait until this worker actually controls the page, otherwise the very
      // first download request can bypass the worker and hit the network (404).
      const expectedWorkerUrl = new URL(window.__downloadSwUrl, window.location.href).href;
      if (navigator.serviceWorker.controller?.scriptURL !== expectedWorkerUrl) {
        stepStart('service worker controller')
        try {
          await new Promise((resolve, reject) => {
            const timeout = window.setTimeout(() => {
              navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange);
              reject(new Error('controller timeout'));
            }, 5000);

            function onControllerChange() {
              if (navigator.serviceWorker.controller?.scriptURL !== expectedWorkerUrl) return;
              navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange);
              window.clearTimeout(timeout);
              resolve();
            }

            navigator.serviceWorker.addEventListener('controllerchange', onControllerChange);
          })
          stepEnd('service worker controller')
        } catch (error) {
          stepEnd('service worker controller')
          log('error', 'Service worker controller wait failed', {
            error_name: error?.name,
            error_message: error?.message,
          })
          throw error
        }
      } else {
        log('info', 'Service worker already controls page')
      }

      return {
        ok: true,
        direct: false,
        registration,
        controller: navigator.serviceWorker.controller,
      };
    })().catch((error) => {
      log('error', 'Early service worker setup failed', {
        error_name: error?.name,
        error_message: error?.message,
        error_stack: error?.stack?.split('\n').slice(0, 5).join('\n'),
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

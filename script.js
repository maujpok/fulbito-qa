/* ==========================================================================
   Fulbito — landing page
   ========================================================================== */

(function () {
  'use strict';

  /* ------------------------------------------------------------------------
     CONFIGURACIÓN

     LEADS_ENDPOINT — URL de la web app de Google Apps Script que escribe los
     leads en la planilla. Ver README, sección "Dónde caen los leads".
     Mientras esté vacío, los envíos van a Formspree (50 por mes).
     Cuando esté configurado, Formspree queda solo como respaldo: se usa
     únicamente si Apps Script falla, para no perder el lead.
     ---------------------------------------------------------------------- */
  var LEADS_ENDPOINT = '';
  var FORMSPREE_ENDPOINT = '';
  var CONTACT_EMAIL = 'hola@fulbito.tech';

  /* ------------------------------------------------------------------------
     PÍXELES DE CAMPAÑA

     Cargá cada ID cuando lo tengas. Vacío = ese píxel no se carga y la
     landing funciona igual: no hay ninguna dependencia dura.

     X no acepta nombres de evento propios, pide un id por conversión que sale
     del panel de X Ads (formato tw-xxxxx-xxxxx). Sin ese id, a X solo le
     llega el PageView.
     ---------------------------------------------------------------------- */
  var PIXELS = {
    meta: '',      // Meta Pixel ID, ej. '1234567890123456'
    tiktok: '',    // TikTok Pixel ID, ej. 'CABCDEFGHIJKLMNOPQRS'
    x: ''          // X Pixel ID, ej. 'o1abc'
  };

  var X_EVENT_IDS = {
    waitlist_completed: ''   // ej. 'tw-o1abc-o1def'
  };

  /* Los píxeles solo cargan en producción. QA y local no deben ensuciar las
     conversiones de la campaña ni gastar entregas optimizando con ruido. */
  var PIXEL_HOSTS = ['www.fulbito.tech', 'fulbito.tech'];

  /* Solo la conversión usa el evento estándar de cada red: aparece directo en
     el Ads Manager sin tener que crear una conversión personalizada, y la
     optimización automática funciona mejor contra eventos estándar. El resto
     viaja con el nombre propio, que se lee mejor y no es objetivo de puja.

     Los nombres que dispara la página no cambian: el mapeo es solo de salida,
     y el nombre interno viaja igual como parámetro `fulbito_event` para no
     perder granularidad en el reporte propio. */
  var META_EVENTS = { waitlist_completed: 'CompleteRegistration' };
  var TIKTOK_EVENTS = { waitlist_completed: 'CompleteRegistration' };

  var UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];
  var UTM_STORAGE = 'fulbito:utm';
  var SENT_STORAGE = 'fulbito:lead';

  /* Ventana de atribución. El recorrido real es ver el aviso, entrar, salir y
     volver más tarde a anotarse, así que los UTM tienen que sobrevivir al
     cierre del navegador. */
  var UTM_MAX_AGE = 7 * 24 * 60 * 60 * 1000;

  /* Códigos cortos de los QR impresos. Con la UTM entera la URL se va a 130+
     caracteres, el QR sale de 57 módulos y no escanea en un sticker. */
  var SHORT_CODES = {
    a4:  { utm_source: 'flyer', utm_medium: 'offline',  utm_content: 'flyer_a4_cancha' },
    wpp: { utm_source: 'flyer', utm_medium: 'whatsapp', utm_content: 'flyer_whatsapp' },
    stk: { utm_source: 'flyer', utm_medium: 'offline',  utm_content: 'sticker_vestuario' }
  };
  var SHORT_CODE_CAMPAIGN = '100_capitanes_cordoba';

  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

  /* ========================================================================
     ANALÍTICA

     Capa mínima, sin dependencias. Empuja cada evento a window.dataLayer y,
     si más adelante se carga GA4 (gtag) o cualquier otro tag manager, los
     eventos ya viajan sin tocar esta página. Los UTM se guardan al entrar y
     acompañan a cada lead, así se puede saber qué campaña trajo qué capitán.
     ===================================================================== */

  /* localStorage primero, sessionStorage de respaldo. En modo privado el
     primero tira excepción al escribir, no al leer, así que hay que envolver
     las dos puntas. Si fallan ambas, los UTM viven solo en memoria: la visita
     se atribuye igual, lo que se pierde es la vuelta. */
  function storeRead(key) {
    var raw = null;
    try { raw = window.localStorage.getItem(key); } catch (err) { raw = null; }
    if (raw === null) {
      try { raw = window.sessionStorage.getItem(key); } catch (err) { raw = null; }
    }
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (err) { return null; }
  }

  function storeWrite(key, value) {
    var raw = JSON.stringify(value);
    try { window.localStorage.setItem(key, raw); return; } catch (err) { /* sigue */ }
    try { window.sessionStorage.setItem(key, raw); } catch (err) { /* sin storage */ }
  }

  function readUtm() {
    var params = new URLSearchParams(window.location.search);

    /* Primer toque gana: mientras lo guardado esté dentro de la ventana, no lo
       pisa nada. Si el mismo visitante vuelve por otra red, el crédito queda
       en la que lo trajo la primera vez. */
    var stored = storeRead(UTM_STORAGE);
    if (stored && stored.ts && stored.values &&
        (Date.now() - stored.ts) < UTM_MAX_AGE) {
      return stored.values;
    }

    var found = {};
    var hayUtm = false;

    UTM_KEYS.forEach(function (key) {
      var value = params.get(key);
      if (value) {
        found[key] = value.slice(0, 120);
        hayUtm = true;
      }
    });

    /* El código corto solo se expande si no vinieron UTM explícitos. No
       debería pasar que lleguen juntos; si pasa, gana la URL completa entera
       y no clave por clave, para no armar un registro mezclado. */
    var code = params.get('f');
    if (!hayUtm && code && Object.prototype.hasOwnProperty.call(SHORT_CODES, code)) {
      var mapped = SHORT_CODES[code];
      Object.keys(mapped).forEach(function (key) { found[key] = mapped[key]; });
      found.utm_campaign = SHORT_CODE_CAMPAIGN;
      hayUtm = true;
    }

    if (!hayUtm) return {};

    storeWrite(UTM_STORAGE, { ts: Date.now(), values: found });
    return found;
  }

  var utm = readUtm();

  /* ------------------------------ píxeles --------------------------------
     Los tres snippets dejan una cola global (fbq, ttq, twq) antes de que baje
     el script remoto, así que se puede llamar a track() enseguida: los
     eventos se encolan y salen cuando la librería termina de cargar.
     ---------------------------------------------------------------------- */

  var pixels = { meta: false, tiktok: false, x: false };

  function pixelsAllowed() {
    return PIXEL_HOSTS.indexOf(window.location.hostname) !== -1;
  }

  function loadMeta(id) {
    /* snippet oficial de Meta */
    !function (f, b, e, v, n, t, s) {
      if (f.fbq) return; n = f.fbq = function () {
        n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments);
      };
      if (!f._fbq) f._fbq = n;
      n.push = n; n.loaded = !0; n.version = '2.0'; n.queue = [];
      t = b.createElement(e); t.async = !0; t.src = v;
      s = b.getElementsByTagName(e)[0]; s.parentNode.insertBefore(t, s);
    }(window, document, 'script', 'https://connect.facebook.net/en_US/fbevents.js');

    window.fbq('init', id);
    window.fbq('track', 'PageView');
    pixels.meta = true;
  }

  function loadTiktok(id) {
    /* snippet oficial de TikTok */
    !function (w, d, t) {
      w.TiktokAnalyticsObject = t;
      var ttq = w[t] = w[t] || [];
      ttq.methods = ['page', 'track', 'identify', 'instances', 'debug', 'on', 'off',
                     'once', 'ready', 'alias', 'group', 'enableCookie', 'disableCookie'];
      ttq.setAndDefer = function (obj, method) {
        obj[method] = function () {
          obj.push([method].concat(Array.prototype.slice.call(arguments, 0)));
        };
      };
      for (var i = 0; i < ttq.methods.length; i++) ttq.setAndDefer(ttq, ttq.methods[i]);
      ttq.instance = function (key) {
        var inst = ttq._i[key] || [];
        for (var j = 0; j < ttq.methods.length; j++) ttq.setAndDefer(inst, ttq.methods[j]);
        return inst;
      };
      ttq.load = function (key, options) {
        var url = 'https://analytics.tiktok.com/i18n/pixel/events.js';
        ttq._i = ttq._i || {}; ttq._i[key] = []; ttq._i[key]._u = url;
        ttq._t = ttq._t || {}; ttq._t[key] = +new Date();
        ttq._o = ttq._o || {}; ttq._o[key] = options || {};
        var script = d.createElement('script');
        script.type = 'text/javascript'; script.async = !0; script.src = url + '?sdkid=' + key + '&lib=' + t;
        var first = d.getElementsByTagName('script')[0];
        first.parentNode.insertBefore(script, first);
      };
      ttq.load(id);
      ttq.page();
    }(window, document, 'ttq');
    pixels.tiktok = true;
  }

  function loadX(id) {
    /* snippet oficial de X (uwt.js) */
    !function (e, t, n, s, u, a) {
      e.twq || (s = e.twq = function () {
        s.exe ? s.exe.apply(s, arguments) : s.queue.push(arguments);
      }, s.version = '1.1', s.queue = [],
        u = t.createElement(n), u.async = !0, u.src = 'https://static.ads-twitter.com/uwt.js',
        a = t.getElementsByTagName(n)[0], a.parentNode.insertBefore(u, a));
    }(window, document, 'script');

    window.twq('config', id);
    pixels.x = true;
  }

  function initPixels() {
    if (!pixelsAllowed()) return;
    try { if (PIXELS.meta) loadMeta(PIXELS.meta); } catch (err) { /* no frena la página */ }
    try { if (PIXELS.tiktok) loadTiktok(PIXELS.tiktok); } catch (err) { /* idem */ }
    try { if (PIXELS.x) loadX(PIXELS.x); } catch (err) { /* idem */ }
  }

  /* Un id por evento, compartido entre los tres píxeles. Hoy sirve para que
     no se cuente doble si un evento se manda dos veces; si más adelante se
     suma Conversions API del lado servidor, es lo que permite deduplicar
     contra el hit del navegador. */
  function eventId() {
    try {
      if (window.crypto && typeof window.crypto.randomUUID === 'function') {
        return window.crypto.randomUUID();
      }
    } catch (err) { /* sigue con el respaldo */ }
    return String(Date.now()) + '-' + Math.random().toString(36).slice(2, 10);
  }

  /* Devuelve el nombre estándar si lo hay, y en ese caso deja el nombre propio
     dentro de los parámetros. */
  function mapEvent(table, event, params) {
    if (!Object.prototype.hasOwnProperty.call(table, event)) {
      return { name: event, params: params, estandar: false };
    }
    var conNombre = {};
    Object.keys(params).forEach(function (key) { conNombre[key] = params[key]; });
    conNombre.fulbito_event = event;
    return { name: table[event], params: conNombre, estandar: true };
  }

  function toPixels(event, params, id) {
    if (pixels.meta) {
      try {
        var meta = mapEvent(META_EVENTS, event, params);
        /* `track` para los estándar, `trackCustom` para los propios: Meta
           rechaza un nombre desconocido enviado por `track`. */
        window.fbq(meta.estandar ? 'track' : 'trackCustom',
                   meta.name, meta.params, { eventID: id });
      } catch (err) { /* un píxel caído no rompe los otros */ }
    }

    if (pixels.tiktok) {
      try {
        var tt = mapEvent(TIKTOK_EVENTS, event, params);
        window.ttq.track(tt.name, tt.params, { event_id: id });
      } catch (err) { /* idem */ }
    }

    if (pixels.x) {
      var xId = Object.prototype.hasOwnProperty.call(X_EVENT_IDS, event)
        ? X_EVENT_IDS[event] : '';
      if (xId) {
        try { window.twq('event', xId, params); } catch (err) { /* idem */ }
      }
    }
  }

  function track(event, data) {
    var payload = { event: event, event_id: eventId() };

    /* Los UTM guardados viajan con cada evento: sin esto, en el panel de la
       red se ve la conversión pero no de qué pieza salió. */
    UTM_KEYS.forEach(function (key) {
      if (utm[key]) payload[key] = utm[key];
    });

    if (data) {
      Object.keys(data).forEach(function (key) {
        payload[key] = data[key];
      });
    }

    window.dataLayer = window.dataLayer || [];
    window.dataLayer.push(payload);

    if (typeof window.gtag === 'function') {
      window.gtag('event', event, data || {});
    }

    var params = {};
    Object.keys(payload).forEach(function (key) {
      if (key !== 'event' && key !== 'event_id') params[key] = payload[key];
    });
    toPixels(event, params, payload.event_id);
  }

  initPixels();

  window.fulbito = { track: track, utm: utm };

  /* ============================ helpers ================================= */

  function setStatus(el, message, kind) {
    if (!el) return;
    el.textContent = message || '';
    el.classList.remove('is-error');
    if (kind) el.classList.add(kind);
  }

  function fieldOf(input) {
    return input.closest('.field');
  }

  function clearError(field) {
    if (!field) return;
    field.classList.remove('has-error');
    var msg = field.querySelector('.field-error');
    if (msg) msg.remove();
  }

  function showError(field, message) {
    if (!field) return;
    field.classList.add('has-error');
    if (field.querySelector('.field-error')) return;
    var p = document.createElement('p');
    p.className = 'field-error';
    p.textContent = message;
    field.appendChild(p);
  }

  function valueOf(form, name) {
    var checked = form.querySelector('[name="' + name + '"]:checked');
    return checked ? checked.value : '';
  }

  function looksLikePhone(value) {
    return value.replace(/[^0-9]/g, '').length >= 8;
  }

  /* ========================== lead scoring ==============================
     No se le muestra nunca al visitante: viaja junto al lead para poder
     priorizar a quién contactar primero.
     ===================================================================== */

  function scoreLead(lead) {
    var score = 0;

    if (lead.organiza === 'si') score += 30;
    else if (lead.organiza === 'a-veces') score += 15;

    if (lead.integrantes === '20-30' || lead.integrantes === 'mas-30') score += 20;
    if (lead.frecuencia === 'semanal' || lead.frecuencia === 'varias-semana') score += 20;
    if (lead.tipo === 'torneos' || lead.tipo === 'ambos') score += 10;
    if (lead.integrantes && lead.integrantes !== 'menos-10') score += 10;

    return score;
  }

  function segmentOf(score, organiza) {
    if (organiza === 'no') return 'C';
    if (score >= 60) return 'A';
    if (score >= 30) return 'B';
    return 'C';
  }

  /* ============================ formulario ============================== */

  function initLeadForm() {
    var form = document.getElementById('lead-form');
    if (!form) return;

    var card = form.closest('.lead-card');
    var done = document.getElementById('lead-done');
    var doneTitle = document.getElementById('lead-done-title');
    var doneText = document.getElementById('lead-done-text');
    var status = form.querySelector('.form-status');
    var stepLabel = document.getElementById('form-step-label');
    var progressBar = document.getElementById('form-progress-bar');
    var backBtn = document.getElementById('form-back');
    var submitBtn = document.getElementById('form-submit');
    var steps = form.querySelectorAll('.form-step');

    var current = 1;
    var started = false;

    function organizes() {
      return valueOf(form, 'organiza') !== 'no';
    }

    function totalSteps() {
      return organizes() ? 2 : 1;
    }

    function refreshChrome() {
      var total = totalSteps();
      stepLabel.textContent = 'Paso ' + current + ' de ' + total;
      progressBar.style.width = Math.round((current / total) * 100) + '%';
      backBtn.hidden = current === 1;
      submitBtn.textContent = current < total
        ? 'Continuar'
        : (organizes() ? 'Quiero ser Capitán Fundador' : 'Quiero acceso anticipado');
    }

    function goTo(step) {
      current = step;
      Array.prototype.forEach.call(steps, function (node) {
        var isCurrent = Number(node.dataset.step) === step;
        node.hidden = !isCurrent;
        node.classList.toggle('is-active', isCurrent);
      });
      refreshChrome();

      var focusable = form.querySelector('.form-step:not([hidden]) input');
      if (focusable && step > 1) focusable.focus({ preventScroll: true });
      if (card) card.scrollIntoView({ block: 'nearest' });
    }

    /* --------------------------- validación --------------------------- */

    function validateStep1() {
      var ok = true;

      var nombre = form.elements.nombre;
      var contacto = form.elements.contacto;
      var ciudad = form.elements.ciudad;

      [nombre, contacto, ciudad].forEach(function (input) { clearError(fieldOf(input)); });
      clearError(form.querySelector('[data-name="organiza"]'));

      if (nombre.value.trim().length < 2) {
        showError(fieldOf(nombre), 'Contanos cómo te llamás.');
        ok = false;
      }

      var contactoValue = contacto.value.trim();
      if (!EMAIL_RE.test(contactoValue) && !looksLikePhone(contactoValue)) {
        showError(fieldOf(contacto), 'Dejanos un email válido o un WhatsApp con característica.');
        ok = false;
      }

      if (ciudad.value.trim().length < 2) {
        showError(fieldOf(ciudad), '¿De qué ciudad o barrio sos?');
        ok = false;
      }

      if (!valueOf(form, 'organiza')) {
        showError(form.querySelector('[data-name="organiza"]'), 'Elegí una opción.');
        ok = false;
      }

      return ok;
    }

    function validateStep2() {
      var ok = true;
      var groups = [
        ['integrantes', 'Elegí cuántos son.'],
        ['frecuencia', 'Elegí cada cuánto juegan.'],
        ['tipo', 'Elegí una opción.']
      ];

      groups.forEach(function (pair) {
        var field = form.querySelector('[data-name="' + pair[0] + '"]');
        clearError(field);
        if (!valueOf(form, pair[0])) {
          showError(field, pair[1]);
          ok = false;
        }
      });

      return ok;
    }

    /* ----------------------------- envío ------------------------------ */

    function buildLead() {
      var lead = {
        nombre: form.elements.nombre.value.trim(),
        contacto: form.elements.contacto.value.trim(),
        ciudad: form.elements.ciudad.value.trim(),
        organiza: valueOf(form, 'organiza'),
        integrantes: valueOf(form, 'integrantes'),
        frecuencia: valueOf(form, 'frecuencia'),
        tipo: valueOf(form, 'tipo'),
        referrer: document.referrer || '',
        pagina: window.location.pathname + window.location.search,
        fecha: new Date().toISOString()
      };

      UTM_KEYS.forEach(function (key) { lead[key] = utm[key] || ''; });

      lead.score = scoreLead(lead);
      lead.segmento = segmentOf(lead.score, lead.organiza);
      lead._subject = 'Fulbito · lead ' + lead.segmento + ' (' + lead.score + ') — ' + lead.nombre;

      return lead;
    }

    function sendToAppsScript(lead) {
      // text/plain evita el preflight CORS, que Apps Script no responde.
      return fetch(LEADS_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(lead)
      }).then(function (response) {
        if (!response.ok) throw new Error('HTTP ' + response.status);
        return true;
      });
    }

    function sendToFormspree(lead) {
      var body = new FormData();
      Object.keys(lead).forEach(function (key) { body.append(key, lead[key]); });
      body.append('origen', 'landing capitanes fundadores');

      return fetch(FORMSPREE_ENDPOINT, {
        method: 'POST',
        headers: { Accept: 'application/json' },
        body: body
      }).then(function (response) {
        if (!response.ok) throw new Error('HTTP ' + response.status);
        return true;
      });
    }

    function send(lead) {
      if (!LEADS_ENDPOINT) return sendToFormspree(lead);
      return sendToAppsScript(lead).catch(function () {
        // Respaldo: si la planilla no responde, el lead no se pierde.
        return sendToFormspree(lead);
      });
    }

    function finish(lead, silent) {
      if (!silent) {
        track('waitlist_completed', {
          segmento: lead.segmento,
          score: lead.score,
          organiza: lead.organiza
        });
        if (lead.segmento === 'A') track('founder_qualified', { score: lead.score });
      }

      try {
        window.sessionStorage.setItem(SENT_STORAGE, lead.contacto);
      } catch (err) {
        /* sin storage: no es crítico */
      }

      form.hidden = true;
      done.hidden = false;

      var share = document.getElementById('lead-share');

      if (lead.organiza === 'no') {
        doneTitle.textContent = 'Gracias, ya estás en la lista';
        doneText.textContent =
          'Te avisamos apenas puedas usar Fulbito. Si querés adelantar las cosas, ' +
          'pasale el link a quien organiza tu grupo: si entra como Capitán Fundador, ' +
          'entran todos juntos desde el primer partido.';

        if (share) {
          var texto =
            'Mirá esto: una app para organizar los partidos del grupo sin la lista ' +
            'dando vueltas por WhatsApp. Están eligiendo 100 capitanes para entrar ' +
            'antes. ' + window.location.origin + '/';
          share.href = 'https://wa.me/?text=' + encodeURIComponent(texto);
          share.target = '_blank';
          share.rel = 'noopener';
          share.hidden = false;
        }
      } else {
        if (share) share.hidden = true;
        doneTitle.textContent = '¡Listo! Tu grupo quedó anotado';
        doneText.textContent =
          'Ya tenemos tus datos. Te vamos a escribir a ' + lead.contacto +
          ' para conocer tu grupo y coordinar cómo entrás con él a las pruebas.';
      }

      done.focus && done.setAttribute('tabindex', '-1');
      done.focus && done.focus({ preventScroll: true });
    }

    /* ---------------------------- eventos ----------------------------- */

    form.addEventListener('submit', function (event) {
      event.preventDefault();

      if (current === 1) {
        if (!validateStep1()) return;

        if (organizes()) {
          goTo(2);
          return;
        }
      } else if (!validateStep2()) {
        return;
      }

      var lead = buildLead();

      // Campo trampa completado: es un bot. Le mostramos el mismo final que a
      // una persona, pero no se envía nada.
      if (form.elements._gotcha && form.elements._gotcha.value) {
        finish(lead, true);
        return;
      }

      var label = submitBtn.textContent;

      submitBtn.disabled = true;
      submitBtn.textContent = 'Enviando…';
      setStatus(status, '');

      send(lead)
        .then(function () {
          finish(lead);
        })
        .catch(function () {
          setStatus(
            status,
            'No pudimos enviarlo. Probá de nuevo o escribinos a ' + CONTACT_EMAIL + '.',
            'is-error'
          );
          submitBtn.disabled = false;
          submitBtn.textContent = label;
        });
    });

    backBtn.addEventListener('click', function () {
      goTo(1);
    });

    form.addEventListener('input', function () {
      if (started) return;
      started = true;
      track('waitlist_started', {});
    });

    form.addEventListener('change', function (event) {
      var input = event.target;
      if (input.name === 'organiza') {
        clearError(form.querySelector('[data-name="organiza"]'));
        refreshChrome();
        track(input.value === 'no' ? 'organizer_no' : 'organizer_yes', { valor: input.value });
        if (!started) {
          started = true;
          track('waitlist_started', {});
        }
      } else if (input.type === 'radio' || input.type === 'checkbox') {
        clearError(input.closest('.field'));
      }
    });

    refreshChrome();
  }

  /* ============================ navegación ============================== */

  function initNav() {
    var toggle = document.querySelector('.nav-toggle');
    var nav = document.getElementById('nav-menu');
    if (!toggle || !nav) return;

    function close() {
      nav.classList.remove('is-open');
      toggle.setAttribute('aria-expanded', 'false');
      toggle.setAttribute('aria-label', 'Abrir menú');
    }

    toggle.addEventListener('click', function () {
      var open = nav.classList.toggle('is-open');
      toggle.setAttribute('aria-expanded', String(open));
      toggle.setAttribute('aria-label', open ? 'Cerrar menú' : 'Abrir menú');
    });

    nav.addEventListener('click', function (event) {
      if (event.target.closest('a')) close();
    });

    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') close();
    });
  }

  /* ------------------------ header al hacer scroll ---------------------- */

  function initHeader() {
    var header = document.querySelector('.site-header');
    if (!header) return;

    var ticking = false;
    function update() {
      header.classList.toggle('is-stuck', window.scrollY > 12);
      ticking = false;
    }

    window.addEventListener(
      'scroll',
      function () {
        if (!ticking) {
          ticking = true;
          window.requestAnimationFrame(update);
        }
      },
      { passive: true }
    );

    update();
  }

  /* --------------------------- CTA fijo mobile -------------------------- */

  function initStickyCta() {
    var sticky = document.getElementById('sticky-cta');
    var hero = document.querySelector('.hero');
    var target = document.getElementById('capitanes');
    if (!sticky || !hero || !target || !('IntersectionObserver' in window)) return;

    var pastHero = false;
    var onForm = false;

    function update() {
      var show = pastHero && !onForm;
      sticky.hidden = !show;
      document.body.classList.toggle('has-sticky-cta', show);
    }

    new IntersectionObserver(function (entries) {
      pastHero = !entries[0].isIntersecting;
      update();
    }, { threshold: 0 }).observe(hero);

    new IntersectionObserver(function (entries) {
      onForm = entries[0].isIntersecting;
      update();
    }, { threshold: 0 }).observe(target);
  }

  /* ------------------------ animación de aparición ---------------------- */

  function initReveal() {
    var items = document.querySelectorAll('.reveal');
    if (!items.length) return;

    var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced || !('IntersectionObserver' in window)) {
      items.forEach(function (item) { item.classList.add('is-visible'); });
      return;
    }

    var observer = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          entry.target.classList.add('is-visible');
          observer.unobserve(entry.target);
        });
      },
      { rootMargin: '0px 0px -12% 0px', threshold: 0.12 }
    );

    items.forEach(function (item) { observer.observe(item); });
  }

  /* ------------------------------ comunidad -----------------------------
     Los números salen de /data/comunidad.json. Mientras estén en null, la
     banda queda oculta: preferimos no mostrar nada antes que inventar cifras.
     ===================================================================== */

  function initProof() {
    var band = document.getElementById('proof-stats');
    if (!band || !('fetch' in window)) return;

    fetch('/data/comunidad.json', { cache: 'no-cache' })
      .then(function (response) {
        if (!response.ok) throw new Error('HTTP ' + response.status);
        return response.json();
      })
      .then(function (data) {
        var slots = band.querySelectorAll('[data-proof]');
        var visible = 0;

        Array.prototype.forEach.call(slots, function (slot) {
          var value = data[slot.dataset.proof];
          var item = slot.closest('li');
          if (typeof value === 'number' && value > 0) {
            slot.textContent = String(value);
            visible += 1;
          } else if (item) {
            item.hidden = true;
          }
        });

        if (visible > 0) band.hidden = false;
      })
      .catch(function () {
        /* sin datos, la banda sigue oculta */
      });
  }

  /* --------------------------- llegada con hash -------------------------
     Un link compartido con #sumarme tiene que caer bien igual: reubicamos el
     destino una vez cargado todo, para que ningún reacomodo lo deje tapado
     por el header.
     ===================================================================== */

  function initHashLanding() {
    if (!window.location.hash) return;

    var target;
    try {
      target = document.querySelector(window.location.hash);
    } catch (err) {
      return;
    }
    if (!target) return;

    window.addEventListener('load', function () {
      target.scrollIntoView({ block: 'start' });
    });
  }

  /* ---------------------------- scroll interno --------------------------
     Los enlaces internos hacen scroll sin dejar el hash en la URL: al
     refrescar, la página vuelve a empezar arriba en vez de saltar al ancla.
     El "saltar al contenido" queda nativo, porque ahí el hash es lo que
     mueve el foco del teclado.
     ===================================================================== */

  function initAnchorScroll() {
    document.addEventListener('click', function (event) {
      var link = event.target.closest('a[href^="#"]');
      if (!link || link.classList.contains('skip-link')) return;

      var href = link.getAttribute('href');
      if (href.length < 2) return;

      var target = document.querySelector(href);
      if (!target) return;

      event.preventDefault();

      var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      target.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' });
    });
  }

  /* --------------------------- CTA de campaña --------------------------- */

  function initCtaTracking() {
    document.addEventListener('click', function (event) {
      var link = event.target.closest('[data-cta]');
      if (!link) return;
      track('founder_cta_click', { ubicacion: link.dataset.cta });
    });
  }

  /* --------------------------------- init -------------------------------- */

  function init() {
    initNav();
    initHeader();
    initReveal();
    initStickyCta();
    initAnchorScroll();
    initHashLanding();
    initCtaTracking();
    initLeadForm();
    initProof();

    var year = document.getElementById('year');
    if (year) year.textContent = String(new Date().getFullYear());

    track('landing_view', {
      utm_source: utm.utm_source || '(directo)',
      utm_campaign: utm.utm_campaign || ''
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

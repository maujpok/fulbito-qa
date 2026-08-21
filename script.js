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

  var UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];
  var UTM_STORAGE = 'fulbito:utm';
  var SENT_STORAGE = 'fulbito:lead';

  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

  /* ========================================================================
     ANALÍTICA

     Capa mínima, sin dependencias. Empuja cada evento a window.dataLayer y,
     si más adelante se carga GA4 (gtag) o cualquier otro tag manager, los
     eventos ya viajan sin tocar esta página. Los UTM se guardan al entrar y
     acompañan a cada lead, así se puede saber qué campaña trajo qué capitán.
     ===================================================================== */

  function readUtm() {
    var stored = {};
    try {
      stored = JSON.parse(window.sessionStorage.getItem(UTM_STORAGE) || '{}');
    } catch (err) {
      stored = {};
    }

    var params = new URLSearchParams(window.location.search);
    var found = false;

    UTM_KEYS.forEach(function (key) {
      var value = params.get(key);
      if (value) {
        stored[key] = value.slice(0, 120);
        found = true;
      }
    });

    if (found) {
      try {
        window.sessionStorage.setItem(UTM_STORAGE, JSON.stringify(stored));
      } catch (err) {
        /* modo privado: los UTM viven solo en memoria */
      }
    }

    return stored;
  }

  var utm = readUtm();

  function track(event, data) {
    var payload = { event: event };
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
  }

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
      submitBtn.textContent = current < total ? 'Continuar' : 'Quiero ser Capitán Fundador';
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

      if (lead.organiza === 'no') {
        doneTitle.textContent = 'Gracias, quedaste anotado';
        doneText.textContent =
          'Te avisamos cuando Fulbito esté disponible. Si querés adelantarte, pasale ' +
          'este link al que organiza tu grupo: si él entra, entran todos.';
      } else {
        doneTitle.textContent = '¡Listo, capitán!';
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

/* ==========================================================================
   Fulbito — página de acceso por enlace (magic link)

   Resuelve /login/?t={token}: confirma que el enlace sirve y para qué cuenta.

   ⚠️ ESTA PÁGINA NO INICIA SESIÓN, Y ES A PROPÓSITO.

   El backend expone dos endpoints, y sólo se usa el primero:

     GET  {api}/auth/email-link/{token}   ← preview, de sólo lectura
          200 -> { email: "fe••@gmail.com",     // enmascarado por el backend
                   valid: bool,
                   invalidReason: "EXPIRED" | "ALREADY_USED" | null,
                   expiresAt: iso }
          404 -> { error: { code: "EMAIL_LINK_NOT_FOUND", ... } }

     POST {api}/auth/email-link/verify    ← ÉSTE crea la sesión. No se llama.

   Dos razones para no llamar al segundo desde el navegador:

   1. El token es de un solo uso. Cualquier cosa que visite la URL sin que la
      persona haga nada —un antivirus de correo, el prefetch del cliente de
      mail, un crawler— lo quemaría antes de que llegue a usarlo. Que el
      canje sea POST ya protege de eso; llamarlo solo al cargar la página
      tiraría esa protección a la basura.
   2. La sesión que devuelve serviría en el navegador, y Fulbito es una app.
      El canje le corresponde a la app, con su propio deviceId.

   Estado al 2026-09-03: la app no tiene NADA de magic link — ni para pedirlo
   ni para canjearlo (verificado en el repo del app: cero referencias). Por
   eso APP_SOPORTA_LOGIN_LINK está en false y no se ofrece un botón que
   abriría la app para que ignore el enlace. Mismo criterio que el
   APP_PUBLICADA de invite.js.
   ========================================================================== */

(function () {
  'use strict';

  /* ------------------------------ configuración -------------------------- */

  var ENTORNOS = {
    'www.fulbito.tech': { nombre: 'prod', api: 'https://api.fulbito.tech/v1/es' },
    'fulbito.tech':     { nombre: 'prod', api: 'https://api.fulbito.tech/v1/es' },
    'qa.fulbito.tech':  { nombre: 'qa',   api: 'https://sport-team-manager-api-8hud.onrender.com/v1/es' }
  };

  // Poner en true SÓLO cuando DeepLinkResolver maneje /login/ y el app sepa
  // canjear el token. Hasta entonces, el botón abriría la app para nada.
  var APP_SOPORTA_LOGIN_LINK = false;

  var APP_SCHEME = 'fulbitoapp';
  var TOKEN_RE = /^[A-Za-z0-9_-]{6,512}$/;

  // Avisar antes de cortar: la API duerme y despertarla tarda.
  var TIEMPO_AVISO_MS = 8000;
  var TIEMPO_LIMITE_MS = 30000;

  /* -------------------------------- entorno ------------------------------ */

  var host = window.location.hostname;
  var entorno = ENTORNOS[host] || {
    nombre: (host === 'localhost' || host === '127.0.0.1') ? 'local' : 'desconocido',
    api: ''
  };
  var api = entorno.api;

  if (entorno.nombre !== 'prod') {
    var badge = document.getElementById('env-badge');
    if (badge) {
      badge.textContent = entorno.nombre.toUpperCase();
      badge.hidden = false;
    }
  }

  /* --------------------------------- token ------------------------------- */

  // El backend arma siempre `/login/?t=<token>` (email-link.service.ts). Se
  // acepta `token` además de `t` por si alguna versión del mail difiere: es
  // barato y evita un 404 que sería imposible de diagnosticar desde afuera.
  function leerToken() {
    var params = new URLSearchParams(window.location.search);
    return (params.get('t') || params.get('token') || '').trim();
  }

  var token = leerToken();

  /* -------------------------------- pintado ------------------------------ */

  var elLoading = document.getElementById('state-loading');
  var elOk = document.getElementById('state-ok');
  var elError = document.getElementById('state-error');

  function mostrar(seccion) {
    elLoading.hidden = seccion !== 'loading';
    elOk.hidden = seccion !== 'ok';
    elError.hidden = seccion !== 'error';
  }

  function error(titulo, texto) {
    document.getElementById('err-title').textContent = titulo;
    document.getElementById('err-text').textContent = texto;
    mostrar('error');
  }

  // EXPIRED y ALREADY_USED piden mensajes distintos: pedir otro enlace no
  // ayuda si la persona ya entró con éste. Lo señala el propio DTO del
  // backend.
  function errorPorMotivo(motivo) {
    if (motivo === 'ALREADY_USED') {
      error(
        'Este enlace ya se usó',
        'Los enlaces de acceso sirven una sola vez. Si necesitás entrar de ' +
        'nuevo, pedí uno nuevo desde la app.'
      );
      return;
    }
    if (motivo === 'EXPIRED') {
      error(
        'El enlace venció',
        'Por seguridad duran poco. Pedí uno nuevo desde la app y entrá con ' +
        'ese.'
      );
      return;
    }
    error(
      'Este enlace no funciona',
      'Puede estar incompleto o haber vencido. Pedí uno nuevo desde la app.'
    );
  }

  function formatearVencimiento(iso) {
    if (!iso) return '';
    var fecha = new Date(iso);
    if (isNaN(fecha.getTime())) return '';
    // Sin segundos: la precisión no le sirve a nadie y ensucia la tarjeta.
    return fecha.toLocaleString('es-AR', {
      day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit'
    });
  }

  function pintar(datos) {
    // `email` ya viene enmascarado por el backend ("fe••@gmail.com"): alcanza
    // para reconocer la cuenta propia y no alcanza para cosechar la dirección
    // si el token termina en un log o en el historial.
    document.getElementById('login-email').textContent =
      datos.email || 'tu cuenta';

    var meta = document.getElementById('login-meta');
    meta.textContent = '';
    var vence = formatearVencimiento(datos.expiresAt);
    if (vence) {
      var li = document.createElement('li');
      li.textContent = 'Vence el ' + vence;
      meta.appendChild(li);
    }

    if (APP_SOPORTA_LOGIN_LINK) {
      document.getElementById('login-actions').hidden = false;
      document.getElementById('login-hint').textContent =
        '¿No se abrió sola? Abrí Fulbito y volvé a tocar el enlace.';
    }

    mostrar('ok');
  }

  /* ------------------------------ abrir la app --------------------------- */

  function abrirApp() {
    window.location.href =
      APP_SCHEME + '://login?t=' + encodeURIComponent(token);
  }

  var btn = document.getElementById('btn-open');
  if (btn) btn.addEventListener('click', abrirApp);

  /* --------------------------------- arranque ---------------------------- */

  if (!token) {
    error(
      'Falta el código',
      'El enlace llegó incompleto. Copiá del mail la dirección entera, o ' +
      'pedí uno nuevo desde la app.'
    );
  } else if (!TOKEN_RE.test(token)) {
    error(
      'Este enlace no funciona',
      'El código no tiene un formato válido. Pedí uno nuevo desde la app.'
    );
  } else if (!api) {
    error(
      'No pudimos verificar el enlace',
      'Estamos con un problema para validar tu acceso. Probá de nuevo en un ' +
      'rato.'
    );
  } else {
    // fetch() no tiene timeout propio: si la API tarda, el spinner se queda
    // para siempre. La API vive en un plan que duerme, y despertarla puede
    // llevar bastante — asi que no alcanza con abortar rapido: primero se
    // avisa que esta tardando, y recien despues se corta.
    var control = new AbortController();
    var avisoLento = setTimeout(function () {
      var msg = elLoading.querySelector('.state-msg');
      if (msg) msg.textContent = 'Esto esta tardando mas de lo normal…';
    }, TIEMPO_AVISO_MS);
    var corte = setTimeout(function () { control.abort(); }, TIEMPO_LIMITE_MS);
    var listo = function () {
      clearTimeout(avisoLento);
      clearTimeout(corte);
    };

    fetch(api.replace(/\/$/, '') + '/auth/email-link/' + encodeURIComponent(token), {
      headers: { Accept: 'application/json' },
      signal: control.signal
    })
      .then(function (response) {
        listo();
        return response;
      })
      .then(function (response) {
        if (response.status === 404) throw new Error('no-existe');
        if (!response.ok) throw new Error('HTTP ' + response.status);
        return response.json();
      })
      .then(function (datos) {
        // `valid` manda. El 200 sólo dice que el token existe, no que sirva:
        // uno vencido o ya usado también responde 200, con el motivo.
        if (!datos || datos.valid !== true) {
          errorPorMotivo(datos && datos.invalidReason);
          return;
        }
        pintar(datos);
      })
      .catch(function (err) {
        listo();
        if (err && err.message === 'no-existe') {
          errorPorMotivo(null);
        } else if (err && err.name === 'AbortError') {
          error(
            'No pudimos verificar el enlace',
            'El servidor tardo demasiado en responder. Volve a abrir el ' +
            'enlace en un rato.'
          );
        } else {
          error(
            'No pudimos verificar el enlace',
            'Puede ser un problema de conexión. Probá de nuevo en un rato.'
          );
        }
      });
  }
})();

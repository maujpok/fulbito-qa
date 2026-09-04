/* ==========================================================================
   Fulbito — página de invitación

   Resuelve /invite/{token} (y también /invite/?t={token} y /invite/#{token}),
   muestra los datos del grupo y manda a la app.

   Contrato real, GET {api}/groups/invites/{token}, medido contra QA el
   2026-09-01 (ver agents-talks/MENSAJE_equipo_web_2026-09-01.md):
     200 -> { group: { id, name, membersCount },
              invitedBy: { nickname },   // nickname puede venir null
              valid, requiresApproval }
     404 -> { error: { message, code: 'INVITE_NOT_FOUND', statusCode } }

   CORS: ALLOWED_ORIGINS quedó cargado en Render (qa y prod) el 2026-09-03 y
   está verificado — la API responde con Access-Control-Allow-Origin para
   este host. Si alguna vez se cae, el síntoma es cruel: la API responde 200
   y el navegador descarta la respuesta, así que desde acá se ve idéntico a
   un token inválido. La consola del navegador es lo único que los distingue.
   ========================================================================== */

(function () {
  'use strict';

  /* ------------------------------ configuración -------------------------- */

  var ENTORNOS = {
    // hostname -> configuración
    'www.fulbito.tech': { nombre: 'prod', api: 'https://api.fulbito.tech/v1/es' },
    'fulbito.tech':     { nombre: 'prod', api: 'https://api.fulbito.tech/v1/es' },
    'qa.fulbito.tech':  { nombre: 'qa',   api: 'https://sport-team-manager-api-8hud.onrender.com/v1/es' }
  };

  // Base de la API que resuelve invitaciones. Vacío = datos mockeados
  // (sirve para levantar la página en local sin pegarle a nada real).
  var INVITE_API = '';

  // Esquema ya registrado en la app (iOS Info.plist y AndroidManifest).
  // El handler de la app todavía no atiende "invite": ver README.
  var APP_SCHEME = 'fulbitoapp';
  var APP_PUBLICADA = false;

  var STORE_IOS = '';     // completar cuando la app esté en App Store
  var STORE_ANDROID = ''; // completar cuando la app esté en Google Play

  var TOKEN_RE = /^[A-Za-z0-9_-]{6,64}$/;

  // fetch() no tiene timeout propio: sin esto, una API dormida deja el
  // spinner girando para siempre. Se avisa antes de cortar porque
  // despertar la API puede tardar de verdad.
  var TIEMPO_AVISO_MS = 8000;
  var TIEMPO_LIMITE_MS = 30000;
  var INVITE_STORAGE = 'fulbito:invite';

  /* -------------------------------- entorno ------------------------------ */

  var host = window.location.hostname;
  var entorno = ENTORNOS[host] || { nombre: host === 'localhost' || host === '127.0.0.1' ? 'local' : 'desconocido', api: '' };
  var api = INVITE_API || entorno.api;

  if (entorno.nombre !== 'prod') {
    var badge = document.getElementById('env-badge');
    if (badge) {
      badge.textContent = entorno.nombre.toUpperCase();
      badge.hidden = false;
    }
  }

  /* --------------------------------- token ------------------------------- */

  function leerToken() {
    // 1) /invite/{token}
    var partes = window.location.pathname.split('/').filter(Boolean);
    if (partes[0] === 'invite' && partes[1]) return decodeURIComponent(partes[1]);

    // 2) /invite/?t={token} o ?token={token}
    var params = new URLSearchParams(window.location.search);
    var q = params.get('t') || params.get('token');
    if (q) return q;

    // 3) /invite/#{token}
    if (window.location.hash.length > 1) return decodeURIComponent(window.location.hash.slice(1));

    return '';
  }

  var token = leerToken().trim();

  /* ------------------------------ datos mock -----------------------------
     Derivados del token para que cada link muestre algo distinto: sirve para
     probar en QA sin API. Se reemplazan solos cuando INVITE_API tenga valor.
     ===================================================================== */

  var GRUPOS_MOCK = [
    { group: { name: 'Los Pibes del Miércoles', membersCount: 28 }, invitedBy: { nickname: 'Nico' }, valid: true, requiresApproval: false },
    { group: { name: 'Fulbito de los Jueves', membersCount: 14 }, invitedBy: { nickname: 'Fede' }, valid: true, requiresApproval: false },
    { group: { name: 'Los Cuervos FC', membersCount: 34 }, invitedBy: { nickname: 'Seba' }, valid: true, requiresApproval: true }
  ];

  function mockPara(valor) {
    var suma = 0;
    for (var i = 0; i < valor.length; i++) suma += valor.charCodeAt(i);
    return GRUPOS_MOCK[suma % GRUPOS_MOCK.length];
  }

  /* ------------------------------- resolución ---------------------------- */

  function resolver(valor) {
    if (!api) {
      // Sin API: mock con una demora corta para que se vea el estado de carga.
      return new Promise(function (resolve) {
        setTimeout(function () { resolve(mockPara(valor)); }, 450);
      });
    }

    // groups/invites, no invites: la landing le pegaba a un endpoint que
    // nunca existió (medido y corregido el 2026-09-03, ver el mensaje de
    // arriba). Público, sin Authorization — quien abre el link puede no
    // tener cuenta todavía.
    var control = new AbortController();
    var avisoLento = setTimeout(function () {
      var msg = elLoading && elLoading.querySelector('.state-msg');
      if (msg) msg.textContent = 'Esto esta tardando mas de lo normal…';
    }, TIEMPO_AVISO_MS);
    var corte = setTimeout(function () { control.abort(); }, TIEMPO_LIMITE_MS);
    var listo = function () {
      clearTimeout(avisoLento);
      clearTimeout(corte);
    };

    return fetch(api.replace(/\/$/, '') + '/groups/invites/' + encodeURIComponent(valor), {
      headers: { Accept: 'application/json' },
      signal: control.signal
    }).then(function (response) {
      listo();
      if (response.status === 404) throw new Error('no-existe');
      if (!response.ok) throw new Error('HTTP ' + response.status);
      return response.json();
    }, function (err) {
      listo();
      throw err;
    }).then(function (datos) {
      // `valid: false` es una invitación que existe pero ya no sirve
      // (revocada, vencida) — mismo tratamiento que el 404.
      if (datos && datos.valid === false) throw new Error('no-existe');
      return datos;
    });
  }

  /* -------------------------------- pintado ------------------------------ */

  var elLoading = document.getElementById('state-loading');
  var elOk = document.getElementById('state-ok');
  var elError = document.getElementById('state-error');

  function mostrar(seccion) {
    elLoading.hidden = seccion !== 'loading';
    elOk.hidden = seccion !== 'ok';
    elError.hidden = seccion !== 'error';
  }

  function iniciales(nombre) {
    return nombre
      .split(/\s+/)
      .filter(function (p) { return p.length > 2 || /^[A-ZÁÉÍÓÚÑ]/.test(p); })
      .slice(0, 2)
      .map(function (p) { return p.charAt(0).toUpperCase(); })
      .join('') || 'FC';
  }

  function error(titulo, texto) {
    document.getElementById('err-title').textContent = titulo;
    document.getElementById('err-text').textContent = texto;
    mostrar('error');
  }

  function pintar(datos) {
    // El contrato real anida en group/invitedBy, no en campos planos — ver
    // el comentario del encabezado. invitedBy.nickname puede venir null:
    // un usuario sin nickname es un caso normal, no un error.
    var grupo = (datos.group && datos.group.name) || '';
    var anfitrion = (datos.invitedBy && datos.invitedBy.nickname) || '';
    var jugadores = datos.group && datos.group.membersCount;

    document.getElementById('inv-crest').textContent = iniciales(grupo || 'Fulbito');
    document.getElementById('inv-group').textContent = grupo || 'Un grupo de Fulbito';
    document.getElementById('inv-host').textContent = anfitrion || 'Alguien';
    document.getElementById('inv-code').textContent = token;

    var meta = document.getElementById('inv-meta');
    meta.textContent = '';
    [jugadores ? jugadores + ' jugadores' : '']
      .filter(Boolean)
      .forEach(function (texto) {
        var li = document.createElement('li');
        li.textContent = texto;
        meta.appendChild(li);
      });

    // La API no devuelve próximo partido — la sección queda oculta (así
    // arranca en el HTML) hasta que exista ese dato en el contrato.

    // TODO(invite-requires-approval): usar datos.requiresApproval para
    // avisar "vas a quedar pendiente de aprobación" antes del botón, en
    // vez de "vas a entrar". Necesita copy y un lugar en el diseño; se
    // deja afuera de este fix para no inventar UI sin acuerdo de producto.

    if (APP_PUBLICADA) {
      document.getElementById('stores-text').textContent = '¿Todavía no tenés la app? Descargala y entrás directo al grupo.';
      if (STORE_IOS) document.getElementById('store-ios').href = STORE_IOS;
      if (STORE_ANDROID) document.getElementById('store-android').href = STORE_ANDROID;
    }

    mostrar('ok');
  }

  /* ------------------------------ abrir la app --------------------------- */

  function recordarInvitacion() {
    // Deep link diferido: si instala la app después, el token sigue acá.
    try {
      window.localStorage.setItem(
        INVITE_STORAGE,
        JSON.stringify({ token: token, fecha: new Date().toISOString() })
      );
    } catch (err) {
      /* modo privado: seguimos igual */
    }
  }

  function abrirApp() {
    recordarInvitacion();

    var destino = APP_SCHEME + '://invite?token=' + encodeURIComponent(token);
    var volvio = false;

    function alOcultarse() {
      if (document.hidden) volvio = true;
    }
    document.addEventListener('visibilitychange', alOcultarse);

    window.location.href = destino;

    setTimeout(function () {
      document.removeEventListener('visibilitychange', alOcultarse);
      if (volvio) return;

      // La app no se abrió: casi seguro no está instalada.
      var texto = document.getElementById('stores-text');
      texto.textContent = APP_PUBLICADA
        ? 'No encontramos la app en este teléfono. Descargala y entrás directo al grupo.'
        : 'Todavía no está en las tiendas. Guardamos tu invitación: cuando salga, entrás directo a este grupo.';
      document.getElementById('stores-note').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }, 1500);
  }

  /* --------------------------------- arranque ---------------------------- */

  var btn = document.getElementById('btn-open');
  if (btn) btn.addEventListener('click', abrirApp);

  if (!token) {
    error('Falta el código', 'El link llegó incompleto. Pedile al que te invitó que te lo mande de nuevo, entero.');
  } else if (!TOKEN_RE.test(token)) {
    error('Este link no funciona', 'El código de invitación no tiene un formato válido. Pedile uno nuevo al que te invitó.');
  } else {
    resolver(token)
      .then(pintar)
      .catch(function (err) {
        if (err && err.message === 'no-existe') {
          error('La invitación venció', 'Este link ya no está activo. Pedile al que te invitó que te mande uno nuevo.');
        } else if (err && err.name === 'AbortError') {
          error('No pudimos abrir la invitación', 'El servidor tardó demasiado en responder. Probá de nuevo en un rato.');
        } else {
          error('No pudimos abrir la invitación', 'Puede ser un problema de conexión. Probá de nuevo en un rato.');
        }
      });
  }
})();

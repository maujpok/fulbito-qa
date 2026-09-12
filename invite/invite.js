/* ==========================================================================
   Fulbito — página de invitación

   Resuelve /invite/{token} (y también /invite/?t={token} y /invite/#{token}),
   muestra los datos del grupo y manda a la app.

   Contrato, GET {api}/groups/invites/{token} — público, sin Authorization:
   quien abre el link puede no tener cuenta todavía.

     200 -> { group:     { id, name, membersCount },
              invitedBy: { nickname },     // puede venir null
              valid, requiresApproval,
              invalidReason }              // sólo cuando valid es false
     404 -> { error: { message, code: 'INVITE_NOT_FOUND', statusCode } }

   ⚠️ Un 200 no significa que el link sirva: `valid` manda sobre el status. Un
   token vencido, revocado o ya usado responde 200 con `valid: false` y el
   motivo en `invalidReason`. Un token que NO EXISTE responde 404.

   Son cinco ramas, no cuatro. Y el 404 no es un caso raro: es el link
   truncado al copiarlo de WhatsApp. Por eso tiene copy propio y no cae en el
   mensaje genérico — ver errorNoExiste().

   ⚠️ Medido el 2026-09-08 contra qa y prod: el 404 y su `code` están
   verificados. Los valores de `invalidReason` NO se pudieron verificar en
   este endpoint (hace falta un token inválido real de QA), así que
   errorPorMotivo() trata el motivo desconocido como un caso normal y cae en
   un mensaje genérico. Dice menos, no dice mal.

   Sin datos mock, a propósito. El mock derivaba un grupo del token, y en
   cualquier host que no estuviera en ENTORNOS la página mostraba "Los Pibes
   del Miércoles, 28 jugadores" para una invitación real: un bug que no rompe,
   sólo miente. Mismo criterio que player.js, que nunca lo tuvo.

   CORS: ALLOWED_ORIGINS quedó cargado en Render (qa y prod) el 2026-09-03 y
   está verificado — la API responde con Access-Control-Allow-Origin para
   este host. Si alguna vez se cae, el síntoma es cruel: la API responde 200
   y el navegador descarta la respuesta, así que desde acá se ve idéntico a
   un token inválido. La consola del navegador es lo único que los distingue.
   ========================================================================== */

(function () {
  'use strict';

  /* ------------------------------ configuración -------------------------- */

  var API_QA = 'https://sport-team-manager-api-8hud.onrender.com/v1/es';

  var ENTORNOS = {
    // hostname -> configuración
    'www.fulbito.tech': { nombre: 'prod', api: 'https://api.fulbito.tech/v1/es' },

    // El ápex no está en ALLOWED_ORIGINS de la API de producción (medido el
    // 2026-09-08), pero GitHub Pages responde 301 al www antes de que corra
    // este JS. La entrada queda como defensa en profundidad.
    'fulbito.tech':     { nombre: 'prod', api: 'https://api.fulbito.tech/v1/es' },

    'qa.fulbito.tech':  { nombre: 'qa',   api: API_QA },

    // Para levantar la página en local. Apunta a QA, que es la API que el
    // mock venía simulando; sin esto, local caería en la rama sin API.
    'localhost':        { nombre: 'local', api: API_QA },
    '127.0.0.1':        { nombre: 'local', api: API_QA }
  };

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
  var entorno = ENTORNOS[host] || { nombre: 'desconocido', api: '' };
  var api = entorno.api;

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

  /* ------------------------------- resolución ---------------------------- */

  function resolver(valor) {
    // groups/invites, no invites: la landing le pegaba a un endpoint que
    // nunca existió (medido y corregido el 2026-09-03). Público, sin
    // Authorization — quien abre el link puede no tener cuenta todavía.
    var control = new AbortController();
    var avisoLento = setTimeout(function () {
      var msg = elLoading && elLoading.querySelector('.state-msg');
      if (msg) msg.textContent = 'Esto está tardando más de lo normal…';
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
    });
    // `valid` no se mira acá: el que llama necesita el invalidReason para
    // elegir el mensaje, y un throw lo perdería.
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

  /* --------------------------- las ramas de error ------------------------ */

  // Los motivos piden mensajes distintos, y no es cosmético: colapsarlos en
  // "no funciona" manda a pedir una invitación nueva a alguien que ya está
  // adentro, o a insistir con una que el organizador dio de baja a propósito.
  function errorPorMotivo(motivo) {
    if (motivo === 'EXPIRED') {
      error(
        'La invitación venció',
        'Las invitaciones duran un tiempo limitado. Pedile una nueva a quien ' +
        'organiza el grupo: con eso alcanza.'
      );
      return;
    }
    if (motivo === 'REVOKED') {
      error(
        'La invitación fue dada de baja',
        'Quien organiza el grupo anuló esta invitación. Pedir otra no va a ' +
        'servir hasta que hables con esa persona.'
      );
      return;
    }
    if (motivo === 'USED' || motivo === 'ALREADY_CLAIMED') {
      error(
        'Ya usaste esta invitación',
        'Alguien la aceptó, probablemente vos. Entrá a Fulbito con tu cuenta ' +
        'y vas a encontrar el grupo ahí.'
      );
      return;
    }
    // Motivo desconocido, o un 200 con valid:false sin invalidReason: ver el
    // ⚠️ del encabezado.
    error(
      'Esta invitación no funciona',
      'Puede haber vencido o haber sido dada de baja. Pedile una nueva a ' +
      'quien organiza el grupo.'
    );
  }

  // El 404 no cae en el genérico: es el link truncado al copiarlo de
  // WhatsApp. Decirle "venció" a quien pegó mal la dirección lo manda a
  // pedir una invitación nueva que va a fallar exactamente igual.
  function errorNoExiste() {
    error(
      'Este link no funciona',
      'Puede que haya llegado cortado. Copiá la dirección entera del mensaje, ' +
      'o pedile una nueva a quien organiza el grupo.'
    );
  }

  function pintar(datos) {
    // El contrato anida en group/invitedBy, no en campos planos — ver el
    // comentario del encabezado. invitedBy.nickname puede venir null: un
    // usuario sin nickname es un caso normal, no un error.
    var grupo = (datos.group && datos.group.name) || '';
    var anfitrion = (datos.invitedBy && datos.invitedBy.nickname) || '';
    var jugadores = datos.group && datos.group.membersCount;

    document.getElementById('inv-crest').textContent = iniciales(grupo || 'Fulbito');
    document.getElementById('inv-group').textContent = grupo || 'Un grupo de Fulbito';
    document.getElementById('inv-host').textContent = anfitrion || 'Alguien';
    document.getElementById('inv-code').textContent = token;

    var meta = document.getElementById('inv-meta');
    meta.textContent = '';
    [jugadores ? jugadores + (jugadores === 1 ? ' jugador' : ' jugadores') : '']
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
  } else if (!api) {
    // Host que no está en ENTORNOS. Acá antes se mostraba un grupo inventado:
    // ahora se dice que no se pudo verificar, que es lo único cierto.
    error(
      'No pudimos abrir la invitación',
      'Estamos con un problema para validar tu invitación. Probá de nuevo en un rato.'
    );
  } else {
    resolver(token)
      .then(function (datos) {
        // Estricto a propósito: con `=== false`, un `valid` ausente o null
        // pintaba la tarjeta de una invitación que no sirve.
        if (!datos || datos.valid !== true) {
          errorPorMotivo(datos && datos.invalidReason);
          return;
        }
        pintar(datos);
      })
      .catch(function (err) {
        if (err && err.message === 'no-existe') {
          errorNoExiste();
        } else if (err && err.name === 'AbortError') {
          error('No pudimos abrir la invitación', 'El servidor tardó demasiado en responder. Probá de nuevo en un rato.');
        } else {
          // CORS entra por acá — ver el encabezado.
          error('No pudimos abrir la invitación', 'Puede ser un problema de conexión. Probá de nuevo en un rato.');
        }
      });
  }
})();

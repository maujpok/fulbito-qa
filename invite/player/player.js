/* ==========================================================================
   Fulbito — claim de participante guest

   Resuelve /invite/player/?t={token}: muestra el grupo, quién sos ahí dentro
   y el historial que ya tenés, para que puedas reclamarlo desde la app.

   Esta ruta existe porque el caso más común del link es el peor: el
   organizador anota a mano a alguien que todavía no es usuario y le manda el
   enlace. Con la app instalada iOS y Android lo interceptan antes que el
   navegador y esto no se ve nunca; sin la app, esto es todo lo que hay.

   Contrato, GET {api}/guest-claims/{token} — público, sin sesión: el token es
   la credencial y quien abre el link puede no tener cuenta.

     200 -> { group:       { id, name, membersCount },
              participant: { id, displayName },
              history:     { matchesPlayed, goals, assists, mvpCount },
              valid, invalidReason }
     404 -> { error: { message, code: 'GUEST_CLAIM_TOKEN_NOT_FOUND', ... } }

   ⚠️ Un 200 no significa que el link sirva: `valid` manda. Un token vencido,
   anulado o ya usado también responde 200, con el motivo en `invalidReason`.

   Sin datos mock, a propósito. En /invite/ el mock leía campos planos
   inventados y la página mostraba "Un grupo de Fulbito" con invitaciones
   reales: un bug que no rompe, sólo miente. Acá, si no hay API, se dice que
   no se pudo verificar.
   ========================================================================== */

(function () {
  'use strict';

  /* ------------------------------ configuración -------------------------- */

  var ENTORNOS = {
    'www.fulbito.tech': { nombre: 'prod', api: 'https://api.fulbito.tech/v1/es' },
    'fulbito.tech':     { nombre: 'prod', api: 'https://api.fulbito.tech/v1/es' },
    'qa.fulbito.tech':  { nombre: 'qa',   api: 'https://sport-team-manager-api-8hud.onrender.com/v1/es' }
  };

  // El claim exige sesión (POST /guest-claims/{token}/claim la pide) y Fulbito
  // es una app: esta página muestra y convence, el claim lo hace el cliente
  // nativo. Poner en true cuando la app esté publicada y DeepLinkResolver
  // atienda "guest-claim"; hasta entonces el botón abriría una app que no
  // está. Mismo criterio que APP_PUBLICADA en invite.js.
  var APP_PUBLICADA = false;

  var APP_SCHEME = 'fulbitoapp';
  var TOKEN_RE = /^[A-Za-z0-9_-]{6,512}$/;
  var CLAIM_STORAGE = 'fulbito:guest-claim';

  // fetch() no tiene timeout propio y la API duerme: sin esto, un cold start
  // deja el spinner girando para siempre. Se avisa a los 8s y se corta a los
  // 30s con un error propio, distinto del de token inválido.
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

  // El backend arma `/invite/player/?t=<token>` (es lo que declara el AASA).
  // Se acepta `token` y la forma con el token en la ruta por si alguna versión
  // difiere: es barato y evita un 404 imposible de diagnosticar desde afuera.
  function leerToken() {
    var params = new URLSearchParams(window.location.search);
    var q = params.get('t') || params.get('token');
    if (q) return q;

    var partes = window.location.pathname.split('/').filter(Boolean);
    if (partes[0] === 'invite' && partes[1] === 'player' && partes[2]) {
      return decodeURIComponent(partes[2]);
    }

    if (window.location.hash.length > 1) {
      return decodeURIComponent(window.location.hash.slice(1));
    }
    return '';
  }

  var token = leerToken().trim();

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

  // Los cuatro motivos piden mensajes distintos, y no es cosmético:
  // colapsarlos en "no funciona" manda a pedir un enlace nuevo a alguien que
  // en realidad ya está adentro.
  function errorPorMotivo(motivo) {
    if (motivo === 'EXPIRED') {
      error(
        'El enlace venció',
        'Los enlaces para reclamar historial duran un tiempo limitado. Pedile ' +
        'uno nuevo a quien organiza tu grupo: con eso alcanza.'
      );
      return;
    }
    if (motivo === 'REVOKED') {
      error(
        'El enlace fue anulado',
        'Quien organiza el grupo dio de baja esta invitación. Pedir otra no ' +
        'va a servir hasta que hables con esa persona.'
      );
      return;
    }
    if (motivo === 'USED' || motivo === 'ALREADY_CLAIMED') {
      error(
        'Este historial ya fue reclamado',
        'Alguien ya usó este enlace, probablemente vos. Entrá a Fulbito con ' +
        'tu cuenta y vas a encontrar el grupo y tus partidos ahí.'
      );
      return;
    }
    error(
      'Este enlace no funciona',
      'Puede estar incompleto o haber vencido. Pedile uno nuevo a quien ' +
      'organiza tu grupo.'
    );
  }

  function iniciales(nombre) {
    return nombre
      .split(/\s+/)
      .filter(function (p) { return p.length > 2 || /^[A-ZÁÉÍÓÚÑ]/.test(p); })
      .slice(0, 2)
      .map(function (p) { return p.charAt(0).toUpperCase(); })
      .join('') || 'FC';
  }

  function numero(valor) {
    return typeof valor === 'number' && isFinite(valor) && valor >= 0 ? valor : 0;
  }

  // Singular y plural: "1 partidos" arruina una tarjeta que existe justamente
  // para que la persona se reconozca en ella.
  function pintarHistorial(history) {
    var h = history || {};
    var filas = [
      { n: numero(h.matchesPlayed), uno: 'partido',     varios: 'partidos' },
      { n: numero(h.goals),         uno: 'gol',         varios: 'goles' },
      { n: numero(h.assists),       uno: 'asistencia',  varios: 'asistencias' },
      { n: numero(h.mvpCount),      uno: 'MVP',         varios: 'MVP' }
    ];

    var lista = document.getElementById('claim-stats');
    var vacio = document.getElementById('claim-stats-vacio');
    lista.textContent = '';

    var total = filas.reduce(function (suma, f) { return suma + f.n; }, 0);
    if (total === 0) {
      lista.hidden = true;
      vacio.hidden = false;
      return;
    }

    lista.hidden = false;
    vacio.hidden = true;

    filas.forEach(function (fila) {
      // Un 0 en goles es información; cuatro ceros no lo son, y ese caso ya
      // se resolvió arriba.
      var li = document.createElement('li');
      var b = document.createElement('b');
      b.textContent = String(fila.n);
      var span = document.createElement('span');
      span.textContent = fila.n === 1 ? fila.uno : fila.varios;
      li.appendChild(b);
      li.appendChild(span);
      lista.appendChild(li);
    });
  }

  function pintar(datos) {
    // Contra el contrato, no contra un mock: los campos anidan en group,
    // participant e history.
    var grupo = (datos.group && datos.group.name) || '';
    var jugador = (datos.participant && datos.participant.displayName) || '';
    var integrantes = datos.group && datos.group.membersCount;

    document.getElementById('claim-crest').textContent = iniciales(grupo || 'Fulbito');
    document.getElementById('claim-group').textContent = grupo || 'Tu grupo';
    document.getElementById('claim-name').textContent = jugador || 'parte del grupo';

    var meta = document.getElementById('claim-meta');
    meta.textContent = '';
    if (integrantes) {
      var li = document.createElement('li');
      li.textContent = integrantes + (integrantes === 1 ? ' jugador' : ' jugadores');
      meta.appendChild(li);
    }

    pintarHistorial(datos.history);

    // El token se guarda igual, esté la app publicada o no: es lo que permite
    // que el claim siga siendo posible cuando la instale más tarde.
    recordarClaim();

    if (APP_PUBLICADA) {
      document.getElementById('claim-actions').hidden = false;
      document.getElementById('claim-hint').textContent =
        '¿No se abrió sola? Abrí Fulbito y volvé a tocar el enlace.';
    }

    mostrar('ok');
  }

  /* ------------------------------ abrir la app --------------------------- */

  function recordarClaim() {
    // Deep link diferido: si instala la app después, el token sigue acá.
    try {
      window.localStorage.setItem(
        CLAIM_STORAGE,
        JSON.stringify({ token: token, fecha: new Date().toISOString() })
      );
    } catch (err) {
      /* modo privado: seguimos igual */
    }
  }

  function abrirApp() {
    recordarClaim();
    window.location.href =
      APP_SCHEME + '://invite/player?t=' + encodeURIComponent(token);
  }

  var btn = document.getElementById('btn-open');
  if (btn) btn.addEventListener('click', abrirApp);

  /* -------------------------------- arranque ----------------------------- */

  if (!token) {
    error(
      'Falta el código',
      'El enlace llegó incompleto. Copiá la dirección entera del mensaje, o ' +
      'pedile una nueva a quien organiza tu grupo.'
    );
  } else if (!TOKEN_RE.test(token)) {
    error(
      'Este enlace no funciona',
      'El código no tiene un formato válido. Pedile uno nuevo a quien ' +
      'organiza tu grupo.'
    );
  } else if (!api) {
    error(
      'No pudimos verificar el enlace',
      'Estamos con un problema para validar tu invitación. Probá de nuevo en ' +
      'un rato.'
    );
  } else {
    var control = new AbortController();
    var avisoLento = setTimeout(function () {
      var msg = elLoading.querySelector('.state-msg');
      if (msg) msg.textContent = 'Esto está tardando más de lo normal…';
    }, TIEMPO_AVISO_MS);
    var corte = setTimeout(function () { control.abort(); }, TIEMPO_LIMITE_MS);
    var listo = function () {
      clearTimeout(avisoLento);
      clearTimeout(corte);
    };

    fetch(api.replace(/\/$/, '') + '/guest-claims/' + encodeURIComponent(token), {
      headers: { Accept: 'application/json' },
      signal: control.signal
    })
      .then(function (response) {
        listo();
        if (response.status === 404) throw new Error('no-existe');
        if (!response.ok) throw new Error('HTTP ' + response.status);
        return response.json();
      }, function (err) {
        listo();
        throw err;
      })
      .then(function (datos) {
        if (!datos || datos.valid !== true) {
          errorPorMotivo(datos && datos.invalidReason);
          return;
        }
        pintar(datos);
      })
      .catch(function (err) {
        if (err && err.message === 'no-existe') {
          errorPorMotivo(null);
        } else if (err && err.name === 'AbortError') {
          error(
            'No pudimos verificar el enlace',
            'El servidor tardó demasiado en responder. Volvé a abrir el ' +
            'enlace en un rato.'
          );
        } else {
          // CORS entra por acá, y el síntoma es cruel: la API responde 200 y
          // el navegador descarta la respuesta, así que desde la página se ve
          // igual que un token inválido. La consola es lo único que los
          // distingue — de ahí que esté en el checklist de verificación.
          error(
            'No pudimos verificar el enlace',
            'Puede ser un problema de conexión. Probá de nuevo en un rato.'
          );
        }
      });
  }
})();

/* ==========================================================================
   Fulbito — página de invitación

   Resuelve /invite/{token} (y también /invite/?t={token} y /invite/#{token}),
   muestra los datos del grupo y manda a la app.

   Hoy los datos son MOCK: no hay API todavía. Cuando exista, alcanza con
   completar INVITE_API abajo; el resto del flujo ya está.
   ========================================================================== */

(function () {
  'use strict';

  /* ------------------------------ configuración -------------------------- */

  var ENTORNOS = {
    // hostname -> configuración
    'www.fulbito.tech': { nombre: 'prod', api: '' },
    'fulbito.tech':     { nombre: 'prod', api: '' },
    'qa.fulbito.tech':  { nombre: 'qa',   api: '' }
  };

  // Base de la API que resuelve invitaciones. Vacío = datos mockeados.
  // Se espera: GET {api}/invites/{token}
  //   200 -> { grupo, anfitrion, jugadores, proximoPartido: { cuando, donde } }
  //   404 -> invitación inexistente o vencida
  var INVITE_API = '';

  // Esquema ya registrado en la app (iOS Info.plist y AndroidManifest).
  // El handler de la app todavía no atiende "invite": ver README.
  var APP_SCHEME = 'fulbitoapp';
  var APP_PUBLICADA = false;

  var STORE_IOS = '';     // completar cuando la app esté en App Store
  var STORE_ANDROID = ''; // completar cuando la app esté en Google Play

  var TOKEN_RE = /^[A-Za-z0-9_-]{6,64}$/;
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
    {
      grupo: 'Los Pibes del Miércoles', anfitrion: 'Nico',
      jugadores: 28,
      proximoPartido: { cuando: 'Miércoles 21:00', donde: 'Complejo El Nido · Cancha 2' }
    },
    {
      grupo: 'Fulbito de los Jueves', anfitrion: 'Fede',
      jugadores: 14,
      proximoPartido: { cuando: 'Jueves 20:30', donde: 'La Bombonerita · Cancha 1' }
    },
    {
      grupo: 'Los Cuervos FC', anfitrion: 'Seba',
      jugadores: 34,
      proximoPartido: { cuando: 'Sábado 16:00', donde: 'Club Atlético · Cancha principal' }
    }
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

    return fetch(api.replace(/\/$/, '') + '/invites/' + encodeURIComponent(valor), {
      headers: { Accept: 'application/json' }
    }).then(function (response) {
      if (response.status === 404) throw new Error('no-existe');
      if (!response.ok) throw new Error('HTTP ' + response.status);
      return response.json();
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
    document.getElementById('inv-crest').textContent = iniciales(datos.grupo || 'Fulbito');
    document.getElementById('inv-group').textContent = datos.grupo || 'Un grupo de Fulbito';
    document.getElementById('inv-host').textContent = datos.anfitrion || 'Alguien';
    document.getElementById('inv-code').textContent = token;

    var meta = document.getElementById('inv-meta');
    meta.textContent = '';
    [datos.jugadores ? datos.jugadores + ' jugadores' : '']
      .filter(Boolean)
      .forEach(function (texto) {
        var li = document.createElement('li');
        li.textContent = texto;
        meta.appendChild(li);
      });

    var proximo = datos.proximoPartido;
    if (proximo && (proximo.cuando || proximo.donde)) {
      document.getElementById('inv-next-when').textContent = proximo.cuando || '';
      document.getElementById('inv-next-where').textContent = proximo.donde || '';
      document.getElementById('inv-next').hidden = false;
    }

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
        } else {
          error('No pudimos abrir la invitación', 'Puede ser un problema de conexión. Probá de nuevo en un rato.');
        }
      });
  }
})();

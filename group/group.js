/* ==========================================================================
   Fulbito — grupo compartido desde la app

   Resuelve /group/{id} (y /group/?g={id}). La app genera estos links con
   AppUrls.groupLink cuando alguien comparte un grupo desde el menú.

   Con la app instalada, iOS y Android interceptan el link antes que el
   navegador y esto no se ve nunca. Sin la app, esto es todo lo que hay — y
   hasta el 2026-09-08 lo que había era un 404.

   ⚠️ NO CONSULTA LA API, y no es un olvido: no existe endpoint público de
   grupo. GET /v1/es/groups/{id} responde 401 AUTH_HEADER_MISSING (medido el
   2026-09-08 en qa y en prod). Así que esta página no puede saber a qué grupo
   apunta el link.

   Las opciones eran inventar el dato o no mostrarlo. En /invite/ hubo un mock
   que derivaba un grupo del token y mostraba "Los Pibes del Miércoles" para
   invitaciones reales: un bug que no rompe, sólo miente. Se borró el mismo
   día que se escribió esta página. Acá no se repite.

   Lo que la página SÍ hace, y es su valor real: guardar el id en
   localStorage. Si la persona instala la app más tarde, el grupo sigue acá.
   Mismo patrón que fulbito:invite y fulbito:guest-claim.
   ========================================================================== */

(function () {
  'use strict';

  /* ------------------------------ configuración -------------------------- */

  // La tabla se mantiene aunque no se consulte la API: la insignia de entorno
  // sirve para saber en qué host estás cuando algo no abre.
  var ENTORNOS = {
    'www.fulbito.tech': 'prod',
    'fulbito.tech':     'prod',
    'qa.fulbito.tech':  'qa',
    'localhost':        'local',
    '127.0.0.1':        'local'
  };

  // Poner en true cuando la app esté publicada y su handler de deep links
  // atienda "group". Hasta entonces el botón abriría una app que no está.
  // Mismo criterio que APP_PUBLICADA en invite.js y player.js.
  var APP_PUBLICADA = false;

  var APP_SCHEME = 'fulbitoapp';
  var GROUP_STORAGE = 'fulbito:group';

  // Los ids que devuelve la API son UUID (36 caracteres). El techo de 128 es
  // defensivo, no una medición: sirve para descartar basura, no para validar.
  var ID_RE = /^[A-Za-z0-9_-]{6,128}$/;

  /* -------------------------------- entorno ------------------------------ */

  var host = window.location.hostname;
  var entorno = ENTORNOS[host] || 'desconocido';

  if (entorno !== 'prod') {
    var badge = document.getElementById('env-badge');
    if (badge) {
      badge.textContent = entorno.toUpperCase();
      badge.hidden = false;
    }
  }

  /* ----------------------------------- id -------------------------------- */

  // ⚠️ No sé qué forma exacta emite AppUrls.groupLink — si /group/{id} o
  // /group/?g={id}. Se aceptan las dos, más ?id=, ?t= y el hash: es barato y
  // evita un 404 imposible de diagnosticar desde afuera. Misma defensa que
  // player.js. Cuando el equipo del app confirme la forma real, se puede
  // recortar a esa.
  function leerId() {
    var params = new URLSearchParams(window.location.search);
    var q = params.get('g') || params.get('id') || params.get('t');
    if (q) return q;

    var partes = window.location.pathname.split('/').filter(Boolean);
    if (partes[0] === 'group' && partes[1]) return decodeURIComponent(partes[1]);

    if (window.location.hash.length > 1) {
      return decodeURIComponent(window.location.hash.slice(1));
    }
    return '';
  }

  var id = leerId().trim();

  /* -------------------------------- pintado ------------------------------ */

  var elOk = document.getElementById('state-ok');
  var elError = document.getElementById('state-error');

  function mostrarError() {
    elOk.hidden = true;
    elError.hidden = false;
  }

  /* ------------------------------ abrir la app --------------------------- */

  function recordarGrupo() {
    // Deep link diferido: si instala la app después, el grupo sigue acá.
    try {
      window.localStorage.setItem(
        GROUP_STORAGE,
        JSON.stringify({ id: id, fecha: new Date().toISOString() })
      );
    } catch (err) {
      /* modo privado: seguimos igual */
    }
  }

  function abrirApp() {
    recordarGrupo();
    window.location.href = APP_SCHEME + '://group?id=' + encodeURIComponent(id);
  }

  /* -------------------------------- arranque ----------------------------- */

  if (!id || !ID_RE.test(id)) {
    mostrarError();
    return;
  }

  // Se guarda al cargar, no al tocar el botón: mientras el botón esté oculto
  // —APP_PUBLICADA en false— es lo único que esta página deja hecho.
  recordarGrupo();

  var codigo = document.getElementById('grp-code');
  if (codigo) {
    codigo.textContent = id;
    document.getElementById('grp-code-wrap').hidden = false;
  }

  if (APP_PUBLICADA) {
    var btn = document.getElementById('btn-open');
    if (btn) {
      btn.hidden = false;
      btn.addEventListener('click', abrirApp);
    }
    document.getElementById('stores-text').textContent =
      '¿Todavía no tenés la app? Descargala y entrás directo al grupo.';
  }
})();

/* ==========================================================================
   Fulbito — landing pública del partido (/p/?t=<token>)
   --------------------------------------------------------------------------
   Alguien recibe el link por WhatsApp, NO tiene la app ni cuenta, y tiene que
   poder confirmar escribiendo sólo su nombre. Sin registro, sin mail, sin OTP.

   Contrato (MENSAJE_equipo_web_landing_2026-09-14.md). Tres endpoints
   públicos, ninguno lleva Authorization:

     GET    /public/matches/{token}?g={guestKey}
     PUT    /public/matches/{token}/attendance   { displayName, response, guestKey? }
     DELETE /public/matches/{token}/attendance?g={guestKey}

   ⚠️ Un link que no sirve responde 200 con `valid:false` y `match:null`. El
   404 aparece sólo al ESCRIBIR sobre un token inexistente. Son dos caminos
   distintos y los dos están contemplados.

   ⚠️ MEDIDO EL 2026-09-15: las tres rutas todavía responden 404 "Cannot GET"
   en prod y en QA, con las dos formas de la base (/v1 y /v1/es). Cuando
   despliegue, confirmar BASE_PUBLICA acá abajo. Mientras tanto la página
   muestra el error de "no pudimos abrir el partido", que es lo único cierto.

   Sin datos mock, a propósito: misma regla que invite.js. Un mock que deriva
   el partido del token miente en cualquier host no previsto — un bug que no
   rompe, sólo miente.
   ========================================================================== */

(function () {
  'use strict';

  /* ------------------------------ configuración --------------------------- */

  // La base es /v1, SIN el segmento de idioma que usan las otras cuatro
  // landings. Medido el 2026-09-17: responden las dos formas, /v1 y /v1/es,
  // con el mismo cuerpo. Se usa la que dice el contrato.
  var API_QA = 'https://sport-team-manager-api-8hud.onrender.com/v1';

  var ENTORNOS = {
    'www.fulbito.tech': { nombre: 'prod',  api: 'https://api.fulbito.tech/v1' },

    // El ápex no está en ALLOWED_ORIGINS de la API de producción, pero el
    // hosting responde 301 al www antes de que corra este JS. Defensa en
    // profundidad, igual que en invite.js.
    'fulbito.tech':     { nombre: 'prod',  api: 'https://api.fulbito.tech/v1' },

    'qa.fulbito.tech':  { nombre: 'qa',    api: API_QA },
    'localhost':        { nombre: 'local', api: API_QA },
    '127.0.0.1':        { nombre: 'local', api: API_QA }
  };

  var ALMACEN = 'fulbito:p';
  var TOKEN_RE = /^[A-Za-z0-9_-]{6,64}$/;

  // fetch() no tiene timeout propio. La API en frío tarda 33 s (medido), así
  // que se avisa antes de cortar: despertarla puede tardar de verdad.
  var TIEMPO_AVISO_MS = 8000;
  var TIEMPO_LIMITE_MS = 30000;

  var APP_PUBLICADA = false;
  var STORE_IOS = '';
  var STORE_ANDROID = '';

  // Quien dijo que no queda en CANCELLED (confirmado por backend el 2026-09-17).
  // Antes de esa entrega la API devolvía `me: null` para esa persona, así que no
  // había nada que adivinar: el estado no existía.
  //
  // Se siguen aceptando los otros valores plausibles, y ante uno DESCONOCIDO se
  // vuelve a mostrar el formulario en vez de inventar un estado. Backend nos
  // pidió expresamente dejar ese fallback puesto.
  var ESTADOS_NO_VOY = ['CANCELLED', 'NOT_GOING', 'DECLINED', 'NOT_ATTENDING', 'OUT'];

  // Hasta cuántas guestKey acepta el GET en un solo pedido (contrato: 10).
  var MAX_CLAVES = 10;

  // Son TRES, no cuatro. `REVOKED` existe en el tipo pero NO LLEGA NUNCA:
  // revocar un link BORRA el token en vez de marcarlo, así que buscarlo
  // después no encuentra nada y la respuesta es NOT_FOUND — el mismo caso que
  // un token inventado. Verificado por backend contra QA el 2026-09-17.
  //
  // Por eso el copy de NOT_FOUND no puede decir "fijate que esté completo": a
  // quien le revocaron el link no le falta ningún carácter. Tiene que servir
  // para los dos casos sin afirmar ninguno.
  var MOTIVOS = {
    NOT_FOUND: {
      titulo: 'Este enlace no existe o ya no está disponible',
      texto: 'Puede que se haya cortado al copiarlo, o que el organizador lo haya dado de baja. Pedile uno nuevo.'
    },
    MATCH_CANCELLED: {
      titulo: 'El partido se canceló',
      texto: 'No hay nada para confirmar. Si te parece un error, hablá con el organizador.'
    },
    MATCH_PAST: {
      titulo: 'Este partido ya se jugó',
      texto: 'Pedile al organizador el link del próximo.'
    }
  };

  /* --------------------------------- atajos ------------------------------- */

  function $(id) { return document.getElementById(id); }

  function texto(id, valor) {
    var el = $(id);
    if (el) el.textContent = valor;
  }

  function mostrar(cual) {
    ['loading', 'match', 'invalid'].forEach(function (nombre) {
      var el = $('state-' + nombre);
      if (el) el.hidden = (nombre !== cual);
    });
  }

  function track(evento, datos) {
    if (window.fulbitoAnalytics) window.fulbitoAnalytics.track(evento, datos);
  }

  function enlazarClaim() {
    var b = $('btn-claim');
    if (b) b.addEventListener('click', function () { track('claim_clicked'); });
  }

  /* -------------------------------- entorno ------------------------------- */

  var host = window.location.hostname;
  var entorno = ENTORNOS[host] || { nombre: 'desconocido', api: '' };
  var api = entorno.api;

  if (entorno.nombre !== 'prod') {
    var badge = $('env-badge');
    if (badge) {
      badge.textContent = entorno.nombre.toUpperCase();
      badge.hidden = false;
    }
  }

  /* --------------------------------- token -------------------------------- */

  function leerToken() {
    var params = new URLSearchParams(window.location.search);
    var q = params.get('t') || params.get('token');
    if (q) return q;

    // /p/{token}, por si alguna vez se emite con la ruta
    var partes = window.location.pathname.split('/').filter(Boolean);
    if (partes[0] === 'p' && partes[1]) return decodeURIComponent(partes[1]);

    if (window.location.hash.length > 1) return decodeURIComponent(window.location.hash.slice(1));
    return '';
  }

  var token = leerToken().trim();

  /* ------------------------------- guestKey -------------------------------
     Es la identidad de alguien que no tiene cuenta. Se emite en la PRIMERA
     confirmación y no se vuelve a emitir: si se pierde, esa persona se
     duplica en el grupo.

     🔄 2026-09-17. La primera versión guardaba por token y una lista, porque la
     API no exponía ninguna referencia de grupo y el GET aceptaba una sola `?g=`.
     Backend implementó las dos cosas que faltaban, así que esto dejó de ser
     "mejor esfuerzo" y pasa a ser exacto:

       match.groupRef   una referencia opaca y estable del grupo
       ?g= repetible    hasta 10 claves en un solo pedido

     Se guardan las tres vistas y NUNCA se pisa ninguna:
       porGrupo → la respuesta correcta para el PRÓXIMO partido del mismo grupo
       porToken → volver al MISMO partido. Siempre funciona
       todas    → nada se pierde, ni las claves viejas sin grupo asociado
     -------------------------------------------------------------------- */

  function leerAlmacen() {
    var vacio = { porGrupo: {}, porToken: {}, todas: [] };
    try {
      var crudo = window.localStorage.getItem(ALMACEN);
      var datos = crudo ? JSON.parse(crudo) : null;
      if (!datos || typeof datos !== 'object') return vacio;
      return {
        porGrupo: datos.porGrupo && typeof datos.porGrupo === 'object' ? datos.porGrupo : {},
        porToken: datos.porToken && typeof datos.porToken === 'object' ? datos.porToken : {},
        todas: Array.isArray(datos.todas) ? datos.todas : []
      };
    } catch (err) {
      return vacio;   // modo privado: seguimos igual
    }
  }

  function guardarClave(clave, grupo) {
    if (!clave) return;
    try {
      var datos = leerAlmacen();
      datos.porToken[token] = clave;
      if (grupo) datos.porGrupo[grupo] = clave;
      if (datos.todas.indexOf(clave) === -1) datos.todas.push(clave);
      window.localStorage.setItem(ALMACEN, JSON.stringify(datos));
    } catch (err) {
      /* sin storage la página funciona igual, pero no va a reconocerla después */
    }
  }

  function claveExacta() {
    return leerAlmacen().porToken[token] || '';
  }

  // Para LEER: se mandan todas las que tengamos. La que corresponda al grupo
  // del link va a matchear; las demás la API las ignora, y una clave de otro
  // grupo no filtra que exista — la respuesta es idéntica a no mandarla.
  function clavesParaLeer() {
    var datos = leerAlmacen();
    var lista = [];
    function sumar(c) { if (c && lista.indexOf(c) === -1) lista.push(c); }

    sumar(datos.porToken[token]);                    // la exacta, primero
    for (var i = datos.todas.length - 1; i >= 0; i--) sumar(datos.todas[i]);
    return lista.slice(0, MAX_CLAVES);
  }

  // Para ESCRIBIR hace falta UNA, y la correcta: el PUT acepta una sola. Mandar
  // la de otro grupo crearía un jugador duplicado, así que ante la duda no se
  // manda ninguna.
  function claveParaEscribir(grupo) {
    var datos = leerAlmacen();
    if (grupo && datos.porGrupo[grupo]) return datos.porGrupo[grupo];
    if (datos.porToken[token]) return datos.porToken[token];

    // Sin grupo conocido, una sola clave guardada no tiene ambigüedad posible.
    // Con varias, la API no dice cuál matcheó, así que no se adivina.
    return datos.todas.length === 1 ? datos.todas[0] : '';
  }

  /* --------------------------------- red ---------------------------------- */

  function pedir(ruta, opciones) {
    var control = new AbortController();
    var avisoLento = setTimeout(function () {
      texto('loading-msg', 'Esto está tardando más de lo normal…');
    }, TIEMPO_AVISO_MS);
    var corte = setTimeout(function () { control.abort(); }, TIEMPO_LIMITE_MS);

    var config = opciones || {};
    config.signal = control.signal;
    config.headers = config.headers || {};
    config.headers.Accept = 'application/json';

    return fetch(api.replace(/\/$/, '') + ruta, config).then(function (response) {
      clearTimeout(avisoLento);
      clearTimeout(corte);
      if (response.status === 204) return { status: 204, cuerpo: null };
      return response.json()
        .catch(function () { return null; })
        .then(function (cuerpo) { return { status: response.status, cuerpo: cuerpo }; });
    }, function (err) {
      clearTimeout(avisoLento);
      clearTimeout(corte);
      throw err;
    });
  }

  function codigo(respuesta) {
    return (respuesta && respuesta.cuerpo && respuesta.cuerpo.error && respuesta.cuerpo.error.code) || '';
  }

  function mensajeApi(respuesta) {
    // El contrato dice que `message` ya viene redactado para que lo lea una
    // persona. Se usa tal cual cuando existe.
    return (respuesta && respuesta.cuerpo && respuesta.cuerpo.error && respuesta.cuerpo.error.message) || '';
  }

  /* -------------------------------- formato ------------------------------- */

  var DIAS = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];

  function dosDigitos(n) { return (n < 10 ? '0' : '') + n; }

  // A mano y no con Intl: es-AR devuelve "16-09" y "10:00 p. m.", y acá se
  // quiere "Mié 16/09 · 22:00", que es como lo escribe el grupo en el chat.
  //
  // ⚠️ Se muestra en la hora LOCAL del teléfono. El ejemplo del contrato trae
  //    "2026-09-16T22:00:00.000Z" para un partido de las 22:00, que en
  //    Argentina serían las 19:00. Está preguntado si el campo lleva zona.
  function formatearCuando(iso) {
    var fecha = new Date(iso);
    if (!iso || isNaN(fecha.getTime())) return '';
    return DIAS[fecha.getDay()] + ' ' +
      dosDigitos(fecha.getDate()) + '/' + dosDigitos(fecha.getMonth() + 1) + ' · ' +
      dosDigitos(fecha.getHours()) + ':' + dosDigitos(fecha.getMinutes());
  }

  function formatoCancha(valor) {
    if (!valor) return '';
    var limpio = String(valor).replace(/_/g, ' ').toLowerCase();
    return limpio.charAt(0).toUpperCase() + limpio.slice(1);
  }

  function iniciales(nombre) {
    var palabras = String(nombre || '').trim().split(/\s+/).filter(Boolean);
    if (!palabras.length) return 'FC';
    if (palabras.length === 1) return palabras[0].slice(0, 2).toUpperCase();
    return (palabras[0][0] + palabras[1][0]).toUpperCase();
  }

  /* --------------------------------- estado -------------------------------- */

  var actual = null;   // última respuesta del GET

  function esNoVoy(estado) {
    return ESTADOS_NO_VOY.indexOf(String(estado || '').toUpperCase()) !== -1;
  }

  function estaLleno(match) {
    if (!match || !match.maxPlayers) return false;
    return Number(match.confirmedCount || 0) >= Number(match.maxPlayers);
  }

  /* --------------------------------- pintado ------------------------------- */

  function pintarInvalido(motivo) {
    var copy = MOTIVOS[String(motivo || '').toUpperCase()] || {
      titulo: 'Este enlace no está disponible',
      texto: 'Pedile al organizador que te mande uno nuevo.'
    };
    texto('inv-title', copy.titulo);
    texto('inv-text', copy.texto);
    mostrar('invalid');
  }

  function pintarJugadores(jugadores, yo) {
    var confirmados = [];
    var esperando = [];

    (jugadores || []).forEach(function (j) {
      if (!j || !j.displayName) return;
      if (String(j.status).toUpperCase() === 'WAITING') esperando.push(j.displayName);
      else if (String(j.status).toUpperCase() === 'CONFIRMED') confirmados.push(j.displayName);
    });

    function llenar(lista, nombres) {
      lista.textContent = '';
      nombres.forEach(function (nombre) {
        var li = document.createElement('li');
        li.textContent = nombre;
        if (yo && yo.displayName && nombre === yo.displayName) li.className = 'is-me';
        lista.appendChild(li);
      });
    }

    llenar($('m-players'), confirmados);
    llenar($('m-waiting'), esperando);

    $('m-roster').hidden = !(confirmados.length || esperando.length);
    $('m-wait-label').hidden = !esperando.length;
    $('m-waiting').hidden = !esperando.length;
  }

  function pintarMe(datos) {
    var yo = datos.me;
    var lleno = estaLleno(datos.match);

    var caja = $('m-me');
    var form = $('m-form');
    var btnLeave = $('btn-leave');
    var btnRejoin = $('btn-rejoin');

    // Sin respuesta previa, o con un estado que el contrato no documenta:
    // se muestra el formulario. Dice menos, no dice mal.
    if (!yo || !yo.status || (!esNoVoy(yo.status) &&
        ['CONFIRMED', 'WAITING'].indexOf(String(yo.status).toUpperCase()) === -1)) {
      caja.hidden = true;
      form.hidden = false;
      $('btn-going').textContent = lleno ? 'Sumarme a la lista de espera' : 'Voy';
      $('btn-not-going').hidden = false;
      return;
    }

    form.hidden = true;
    caja.hidden = false;
    btnLeave.hidden = true;
    btnRejoin.hidden = true;
    $('m-me-note').hidden = true;
    caja.className = 'me';

    var estado = String(yo.status).toUpperCase();

    if (estado === 'CONFIRMED') {
      texto('m-me-title', '✅ Estás adentro' + (yo.displayName ? ', ' + yo.displayName : '') + '.');
      btnLeave.hidden = false;
    } else if (estado === 'WAITING') {
      caja.className = 'me is-wait';
      texto('m-me-title', yo.position
        ? 'Sos el #' + yo.position + ' en la lista de espera.'
        : 'Estás en la lista de espera.');
      // El contrato es explícito: NO hay forma de avisarle. No se promete.
      $('m-me-note').hidden = false;
      texto('m-me-note', 'Si alguien se baja, entrás solo. No podemos avisarte: volvé a abrir este link para ver cómo viene.');
      btnLeave.hidden = false;
    } else {
      caja.className = 'me is-out';
      texto('m-me-title', 'Dijiste que no jugás.');
      btnRejoin.hidden = false;
    }
  }

  function pintar(datos) {
    actual = datos;
    var match = datos.match || {};

    texto('m-crest', iniciales(match.groupName));
    texto('m-group', match.groupName || 'Un partido de Fulbito');

    var meta = $('m-meta');
    meta.textContent = '';
    [formatearCuando(match.scheduledAt), match.venueName, formatoCancha(match.fieldFormat)]
      .filter(Boolean)
      .forEach(function (valor) {
        var li = document.createElement('li');
        li.textContent = valor;
        meta.appendChild(li);
      });

    var confirmados = Number(match.confirmedCount || 0);
    var cupo = Number(match.maxPlayers || 0);
    var lleno = estaLleno(match);

    texto('m-count', cupo ? confirmados + '/' + cupo : String(confirmados));
    texto('m-cupo-text', 'confirmados' + (Number(match.waitingCount) > 0
      ? ' · ' + match.waitingCount + ' en espera' : ''));

    var barra = $('m-bar');
    barra.style.width = cupo ? Math.min(100, (confirmados / cupo) * 100) + '%' : '0%';
    barra.parentNode.className = 'bar' + (lleno ? ' is-full' : '');
    $('m-full').hidden = !lleno;

    pintarJugadores(datos.players, datos.me);
    pintarMe(datos);

    // El GET no emite tokens de claim, pero devuelve el vigente si ya existe.
    // Así alguien que vuelve al link sigue viendo el CTA.
    if (datos.me && datos.me.claim) pintarClaim(datos.me.claim);

    mostrar('match');
  }

  // El claim.url lo arma la API con el host del entorno. Se valida igual antes
  // de meterlo en un href: es un dato que viene de la red, y un href acepta
  // esquemas que no queremos (javascript:, data:). Barato y cierra la puerta.
  function urlDeClaimValida(url) {
    if (!url) return false;
    try {
      var u = new URL(url, window.location.origin);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
      if (!ENTORNOS[u.hostname]) return false;          // sólo nuestros hosts
      return u.pathname.indexOf('/invite/player/') === 0;
    } catch (err) {
      return false;
    }
  }

  function pintarClaim(claim) {
    var caja = $('m-claim');
    if (!caja) return;

    var url = claim && claim.url;
    if (!urlDeClaimValida(url)) {
      caja.hidden = true;
      if (url && window.console) {
        console.warn('[fulbito] claim.url descartada por no ser de un host conocido');
      }
      return;
    }

    $('btn-claim').href = url;
    caja.hidden = false;
  }

  function pintarPromo(claim) {
    pintarClaim(claim);

    var promo = $('m-promo');
    if (!promo) return;
    promo.hidden = false;

    if (APP_PUBLICADA) {
      texto('promo-text', 'Listo. ¿Querés tener todos los partidos del grupo en el teléfono?');
      if (STORE_IOS) $('store-ios').href = STORE_IOS;
      if (STORE_ANDROID) $('store-android').href = STORE_ANDROID;
    } else {
      texto('promo-text', 'Listo. Fulbito todavía no está en las tiendas: cuando salga, el grupo entero se organiza desde ahí.');
    }

  }

  function pintarDuplicado(dup) {
    if (!dup || !dup.displayName) return;
    $('m-dup').hidden = false;
    texto('m-dup-title', '¿Sos vos, ' + dup.displayName + '?' +
      (dup.matchesPlayed ? ' Jugó ' + dup.matchesPlayed + ' partidos con el grupo.' : ''));
  }

  /* --------------------------------- errores ------------------------------- */

  function errorForm(mensaje) {
    var caja = $('m-error');
    caja.hidden = false;
    caja.textContent = mensaje;
    $('m-name').classList.add('is-bad');
  }

  function limpiarErrorForm() {
    $('m-error').hidden = true;
    $('m-name').classList.remove('is-bad');
  }

  function errorGeneral(titulo, cuerpo) {
    texto('inv-title', titulo);
    texto('inv-text', cuerpo);
    mostrar('invalid');
  }

  /* --------------------------------- acciones ------------------------------ */

  var enVuelo = false;

  function bloquear(valor) {
    enVuelo = valor;
    ['btn-going', 'btn-not-going', 'btn-leave', 'btn-rejoin'].forEach(function (id) {
      var b = $(id);
      if (b) b.disabled = valor;
    });
  }

  function confirmar(respuesta) {
    if (enVuelo) return;
    limpiarErrorForm();

    var nombre = ($('m-name').value || '').trim();
    if (!nombre) {
      errorForm('Escribí tu nombre para confirmar.');
      $('m-name').focus();
      return;
    }

    track('guest_identified');
    bloquear(true);

    var cuerpo = { displayName: nombre, response: respuesta };
    var clave = claveParaEscribir(actual && actual.match && actual.match.groupRef);
    if (clave) cuerpo.guestKey = clave;

    pedir('/public/matches/' + encodeURIComponent(token) + '/attendance', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cuerpo)
    }).then(function (r) {
      bloquear(false);

      if (r.status >= 200 && r.status < 300 && r.cuerpo) {
        // Se guarda ANTES de pintar, como pide el contrato. El groupRef viene
        // en la misma respuesta que emite la clave, así que queda archivada
        // por grupo sin un viaje extra.
        guardarClave(r.cuerpo.guestKey,
          r.cuerpo.groupRef || (actual && actual.match && actual.match.groupRef));

        track('attendance_confirmed', { response: respuesta, status: r.cuerpo.status });

        actual = actual || { match: {} };
        actual.me = {
          displayName: r.cuerpo.displayName || nombre,
          status: r.cuerpo.status,
          position: r.cuerpo.position
        };
        if (typeof r.cuerpo.confirmedCount === 'number') {
          actual.match = actual.match || {};
          actual.match.confirmedCount = r.cuerpo.confirmedCount;
        }

        pintar(actual);
        pintarDuplicado(r.cuerpo.possibleDuplicate);
        pintarPromo(r.cuerpo.claim);
        return;
      }

      var code = codigo(r);

      if (code === 'PUBLIC_MATCH_NAME_INVALID') {
        errorForm(mensajeApi(r) || 'Ese nombre no sirve. Escribí cómo te conocen en el grupo.');
      } else if (code === 'PUBLIC_MATCH_CANCELLED') {
        pintarInvalido('MATCH_CANCELLED');
      } else if (code === 'PUBLIC_MATCH_PAST') {
        pintarInvalido('MATCH_PAST');
      } else if (code === 'PUBLIC_MATCH_LINK_INVALID' || r.status === 404) {
        pintarInvalido('NOT_FOUND');
      } else if (code === 'PUBLIC_MATCH_GUEST_LIMIT') {
        errorForm(mensajeApi(r) || 'Este partido ya tiene mucha gente anotada por el link. Hablá con el organizador.');
      } else if (r.status === 429) {
        errorForm('Probaste varias veces seguidas. Esperá un momento y volvé a intentar.');
      } else {
        errorForm(mensajeApi(r) || 'No pudimos guardar tu respuesta. Probá de nuevo en un rato.');
      }
    }).catch(function (err) {
      bloquear(false);
      errorForm(err && err.name === 'AbortError'
        ? 'El servidor tardó demasiado. Probá de nuevo en un rato.'
        : 'No pudimos guardar tu respuesta. Puede ser un problema de conexión.');
    });
  }

  function bajarse() {
    if (enVuelo) return;

    var clave = claveExacta();
    if (!clave) {
      // Sin la clave de ESTE partido no hay forma de probar que es esa persona.
      // La API responde 403 y no se puede recuperar: se dice la verdad.
      $('m-me-note').hidden = false;
      texto('m-me-note', 'No podemos identificarte en este teléfono, así que no podés bajarte desde acá. Avisale al organizador.');
      return;
    }

    bloquear(true);
    pedir('/public/matches/' + encodeURIComponent(token) + '/attendance?g=' +
      encodeURIComponent(clave), {
      method: 'DELETE'
    }).then(function (r) {
      bloquear(false);
      if (r.status === 204 || (r.status >= 200 && r.status < 300)) {
        track('attendance_confirmed', { response: 'CANCELLED' });
        $('m-dup').hidden = true;
        $('m-promo').hidden = true;
        cargar();   // se re-piden los datos: los contadores cambiaron
        return;
      }
      $('m-me-note').hidden = false;
      texto('m-me-note', mensajeApi(r) || 'No pudimos darte de baja. Probá de nuevo en un rato.');
    }).catch(function () {
      bloquear(false);
      $('m-me-note').hidden = false;
      texto('m-me-note', 'No pudimos darte de baja. Puede ser un problema de conexión.');
    });
  }

  function volverAAnotarse() {
    if (!actual) return;
    actual.me = null;
    $('m-dup').hidden = true;
    pintar(actual);
    $('m-name').focus();
  }

  /* --------------------------------- carga --------------------------------- */

  function manejar(datos) {
    if (!datos || datos.valid !== true) {
      // Estricto a propósito: con `!== true`, un `valid` ausente o null no
      // pinta la tarjeta de un partido que no existe.
      pintarInvalido(datos && datos.invalidReason);
      return;
    }
    if (datos.me) track('guest_returned');
    pintar(datos);
  }

  function cargar() {
    mostrar('loading');
    texto('loading-msg', 'Buscando el partido…');

    // Todas las claves en un solo pedido. Antes había que elegir una a ciegas,
    // o pagar un request extra para saber de qué grupo era el link — y ese es
    // justo el que paga el cold start de la API.
    var claves = clavesParaLeer();
    var ruta = '/public/matches/' + encodeURIComponent(token) +
      (claves.length
        ? '?' + claves.map(function (c) { return 'g=' + encodeURIComponent(c); }).join('&')
        : '');

    return pedir(ruta, {}).then(function (r) {
      if (r.status === 404 && /Cannot GET/i.test(mensajeApi(r))) {
        // 404 del router, no del contrato: la ruta no está publicada.
        // Medido el 2026-09-15 en los dos entornos.
        if (window.console) {
          console.warn('[fulbito] El endpoint público del partido no responde en ' +
            api + '. Ver PLAN_landing_p_2026-09-15.md §8.');
        }
        errorGeneral('No pudimos abrir el partido',
          'Estamos con un problema para buscar los datos. Probá de nuevo en un rato.');
        return;
      }
      if (r.status >= 200 && r.status < 300) {
        manejar(r.cuerpo);
        return;
      }
      if (r.status === 404) {
        pintarInvalido('NOT_FOUND');
        return;
      }
      errorGeneral('No pudimos abrir el partido',
        mensajeApi(r) || 'Probá de nuevo en un rato.');
    }).catch(function (err) {
      if (err && err.name === 'AbortError') {
        errorGeneral('No pudimos abrir el partido',
          'El servidor tardó demasiado en responder. Probá de nuevo en un rato.');
      } else {
        // CORS entra por acá: la API responde pero el navegador descarta.
        errorGeneral('No pudimos abrir el partido',
          'Puede ser un problema de conexión. Probá de nuevo en un rato.');
      }
    });
  }

  /* ------------------------------ datos embebidos --------------------------
     Cuando /p/ pase por la función (fase 6 de la migración), el documento va a
     venir con la respuesta del GET ya adentro. La página la usa y se saltea el
     pedido: el scraper y la persona ven exactamente lo mismo, y no hay una
     segunda vuelta contra la API.

     Es el ÚNICO contrato entre las dos etapas. Si esto cambia, se rompe.
     ---------------------------------------------------------------------- */

  function datosEmbebidos() {
    var el = $('datos');
    if (!el) return null;
    try {
      var datos = JSON.parse(el.textContent);
      return datos && typeof datos === 'object' ? datos : null;
    } catch (err) {
      return null;
    }
  }

  /* -------------------------------- arranque -------------------------------- */

  $('m-form').addEventListener('submit', function (evento) {
    evento.preventDefault();
    confirmar(estaLleno(actual && actual.match) ? 'WAITLIST' : 'GOING');
  });
  $('btn-not-going').addEventListener('click', function () { confirmar('NOT_GOING'); });
  $('btn-leave').addEventListener('click', bajarse);
  $('btn-rejoin').addEventListener('click', volverAAnotarse);
  $('m-name').addEventListener('input', limpiarErrorForm);

  enlazarClaim();

  ['store-ios', 'store-android'].forEach(function (id) {
    var el = $(id);
    if (el) el.addEventListener('click', function () {
      track('install_clicked', { store: id === 'store-ios' ? 'ios' : 'android' });
    });
  });

  if (window.fulbitoAnalytics) window.fulbitoAnalytics.contexto({ token: token, entorno: entorno.nombre });
  track('match_link_opened');

  if (!token) {
    errorGeneral('Falta el código del partido',
      'El link llegó incompleto. Pedile al organizador que te lo mande de nuevo, entero.');
  } else if (!TOKEN_RE.test(token)) {
    errorGeneral('Este enlace no funciona',
      'El código no tiene un formato válido. A veces se corta al copiarlo de WhatsApp: pedile uno nuevo al organizador.');
  } else if (!api) {
    // Host que no está en ENTORNOS. No se inventa un partido: se dice que no
    // se pudo verificar, que es lo único cierto.
    errorGeneral('No pudimos abrir el partido',
      'Estamos con un problema para validar este enlace. Probá de nuevo en un rato.');
  } else {
    var previos = datosEmbebidos();
    if (previos) manejar(previos);
    else cargar();
  }
})();

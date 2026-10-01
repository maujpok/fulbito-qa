/* ==========================================================================
   Fulbito — la única ruta dinámica del sitio: /p/?t=<token>
   --------------------------------------------------------------------------
   Por qué existe esta función:

   El scraper de WhatsApp NO ejecuta JavaScript. Lee el HTML tal como sale del
   servidor. Para que la tarjeta muestre el grupo, el día y los confirmados
   —y no la tarjeta genérica de la marca— las meta tags tienen que salir ya
   escritas. La API devuelve JSON, no HTML, así que alguien tiene que armar el
   documento: es esta función.

   Un rewrite de tipo proxy NO alcanza: le daría al scraper un JSON.

   Contrato con la página (assets/p.js): además del <head>, se inyecta

       <script type="application/json" id="datos">…</script>

   y p.js lo usa en vez de pedir los datos de nuevo. El scraper y la persona
   ven exactamente lo mismo, y no hay una segunda vuelta contra la API.

   🔴 NUNCA devuelve un error. Un 404 o un 500 hace que WhatsApp no muestre
   tarjeta Y CACHEE esa ausencia. Si la API falla, tarda o todavía no existe,
   se devuelve la página tal cual está en el repo: tarjeta genérica, que es
   exactamente lo que se ve hoy. Degradar, nunca romper.

   Portar a Vercel o Cloudflare: lo único específico de Netlify son las diez
   últimas líneas. `construirHtml` es una función pura.
   ========================================================================== */

import { readFileSync } from 'node:fs';

const PLANTILLA = new URL('../../p/index.html', import.meta.url);

// El scraper espera segundos, no medio minuto. La API despierta responde en
// ~1.1 s (medido); en frío tarda 33 s, y para eso está el cron que la
// mantiene viva. Si igual no llega, se degrada a la tarjeta genérica.
const TIEMPO_LIMITE_MS = 2500;

const API = {
  'www.fulbito.tech': 'https://api.fulbito.tech/v1',
  'qa.fulbito.tech': 'https://sport-team-manager-api-8hud.onrender.com/v1'
};

function escapar(valor) {
  return String(valor === undefined || valor === null ? '' : valor)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const DIAS = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];

function dosDigitos(n) { return (n < 10 ? '0' : '') + n; }

function cuando(iso) {
  const fecha = new Date(iso);
  if (!iso || Number.isNaN(fecha.getTime())) return '';
  return DIAS[fecha.getUTCDay()] + ' ' +
    dosDigitos(fecha.getUTCDate()) + '/' + dosDigitos(fecha.getUTCMonth() + 1) + ' · ' +
    dosDigitos(fecha.getUTCHours()) + ':' + dosDigitos(fecha.getUTCMinutes());
}

/**
 * Arma el documento de /p/ a partir de la plantilla del repo.
 * Pura y sin dependencias: es lo que se prueba.
 *
 * @param {string} plantilla  p/index.html tal cual
 * @param {object|null} datos respuesta de GET /public/matches/{token}
 * @param {string} url        URL canónica de esta página
 */
export function construirHtml(plantilla, datos, url) {
  // Sin datos utilizables la página sale como está: tarjeta de marca.
  if (!datos || datos.valid !== true || !datos.match) return plantilla;

  const m = datos.match;
  const partes = [cuando(m.scheduledAt), m.venueName].filter(Boolean);
  const cupo = m.maxPlayers
    ? `${m.confirmedCount || 0}/${m.maxPlayers} confirmados`
    : `${m.confirmedCount || 0} confirmados`;

  const titulo = m.groupName || 'Te invitaron a jugar un partido';
  const desc = partes.concat(cupo).join(' · ');

  let html = plantilla
    .replace(/<title>[\s\S]*?<\/title>/,
      `<title>${escapar(titulo)}${partes.length ? ' · ' + escapar(partes[0]) : ''}</title>`)
    .replace(/(<meta property="og:title" content=")[^"]*(">)/,
      `$1${escapar(titulo)}$2`)
    .replace(/(<meta property="og:description" content=")[^"]*(">)/,
      `$1${escapar(desc)}$2`)
    .replace(/(<meta name="description" content=")[^"]*(">)/,
      `$1${escapar(desc)}$2`);

  // og:url canónica, que el archivo estático no puede tener
  html = html.replace('<meta property="og:image"',
    `<meta property="og:url" content="${escapar(url)}">\n<meta property="og:image"`);

  // El bloque que p.js busca para saltearse el pedido.
  const bloque = `<script type="application/json" id="datos">` +
    JSON.stringify(datos).replace(/</g, '\\u003c') +
    `</script>`;
  html = html.replace('</main>', '</main>\n' + bloque);

  return html;
}

async function traerDatos(base, token) {
  const control = new AbortController();
  const corte = setTimeout(() => control.abort(), TIEMPO_LIMITE_MS);
  try {
    const r = await fetch(
      `${base}/public/matches/${encodeURIComponent(token)}`,
      { headers: { Accept: 'application/json' }, signal: control.signal }
    );
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;          // API dormida, caída o todavía sin desplegar
  } finally {
    clearTimeout(corte);
  }
}

/* ------------------------------ Netlify ---------------------------------- */

export default async (request) => {
  const plantilla = readFileSync(PLANTILLA, 'utf8');
  const url = new URL(request.url);
  const token = (url.searchParams.get('t') || url.searchParams.get('token') || '').trim();

  const cabeceras = {
    'content-type': 'text/html; charset=utf-8',
    'x-robots-tag': 'noindex, nofollow',
    // Son partidos de grupos privados: no se cachea en intermediarios.
    'cache-control': 'private, max-age=0, must-revalidate'
  };

  const base = API[url.hostname];
  if (!token || !/^[A-Za-z0-9_-]{6,64}$/.test(token) || !base) {
    return new Response(plantilla, { status: 200, headers: cabeceras });
  }

  const datos = await traerDatos(base, token);
  return new Response(construirHtml(plantilla, datos, url.toString()), {
    status: 200, headers: cabeceras
  });
};

export const config = { path: '/p/*' };

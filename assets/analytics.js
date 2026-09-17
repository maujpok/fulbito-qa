/* ==========================================================================
   Fulbito — capa mínima de analítica para las landings
   --------------------------------------------------------------------------
   Empuja eventos a window.dataLayer y, si alguna vez se carga GA4, también a
   gtag. Nada más: sin dependencias y SIN PÍXELES DE TERCEROS.

   Por qué sin píxeles, a propósito:

   1. El pedido de la landing del partido lo exige — "sin cookies de terceros,
      sin tracking de terceros: es una página que ve gente que no aceptó nada".
   2. El token del partido viaja como propiedad de los eventos, y ese token
      AUTORIZA a cambiar la asistencia. Mandarlo a un píxel de terceros sería
      entregar una credencial a un tercero.

   `script.js` (la landing de campaña) tiene su propia track() con los píxeles
   de Meta/TikTok/X. Son dos cosas distintas a propósito y no se unifican: esa
   página sí pide consentimiento de campaña, ésta no.
   ========================================================================== */

(function (w) {
  'use strict';

  // Propiedades que se agregan a todos los eventos de la página.
  var comunes = {};

  function contexto(datos) {
    if (!datos) return;
    Object.keys(datos).forEach(function (clave) {
      if (datos[clave] !== undefined && datos[clave] !== null) comunes[clave] = datos[clave];
    });
  }

  function track(evento, datos) {
    if (!evento) return;

    var payload = { event: evento };
    Object.keys(comunes).forEach(function (k) { payload[k] = comunes[k]; });
    if (datos) Object.keys(datos).forEach(function (k) { payload[k] = datos[k]; });

    try {
      w.dataLayer = w.dataLayer || [];
      w.dataLayer.push(payload);
      if (typeof w.gtag === 'function') w.gtag('event', evento, payload);
    } catch (err) {
      /* la analítica nunca frena la página */
    }
  }

  w.fulbitoAnalytics = { track: track, contexto: contexto };
})(window);

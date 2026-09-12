#!/usr/bin/env bash
#
# Genera la copia del sitio para qa.fulbito.tech.
#
# QA vive en otro repositorio porque GitHub Pages admite un solo dominio propio
# por sitio. Para no mantener dos copias a mano, el contenido se genera desde
# este repo y se publica en el de QA.
#
#   ./scripts/build-qa.sh                # deja el resultado en ./dist-qa
#   ./scripts/build-qa.sh /otra/carpeta  # o donde le indiques
#
set -euo pipefail

raiz="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
salida="${1:-$raiz/dist-qa}"

# Se valida ANTES de tocar nada. Si esto fallara al final, el directorio
# ya tendría los .well-known de PRODUCCIÓN adentro, y alguien que
# ignore el error publicaría exactamente el sitio roto que la guarda
# venía a evitar.
bien_conocido="$raiz/deep-links/qa"
for archivo in assetlinks.json apple-app-site-association; do
  if [ ! -f "$bien_conocido/$archivo" ]; then
    echo "ERROR: falta $bien_conocido/$archivo" >&2
    echo "       Sin eso el sitio de QA quedaría declarando la app de" >&2
    echo "       PRODUCCIÓN, y los deep links de QA dejarían de abrir" >&2
    echo "       la app sin ningún error visible. Ver deep-links/README.md" >&2
    exit 1
  fi
done

rm -rf "$salida"
mkdir -p "$salida"

# Copiamos todo menos el historial de git y salidas previas
tar -c -C "$raiz" \
  --exclude='.git' \
  --exclude='dist-qa' \
  --exclude='node_modules' \
  . | tar -x -C "$salida"

# --- diferencias de QA -------------------------------------------------------

# 1. Dominio propio
echo "qa.fulbito.tech" > "$salida/CNAME"

# 2. QA no se indexa: ni buscadores ni previews accidentales
printf 'User-agent: *\nDisallow: /\n' > "$salida/robots.txt"
rm -f "$salida/sitemap.xml"

# 3. noindex también en el HTML, porque robots.txt no impide que se indexe
#    una página enlazada desde otro lado
for archivo in "$salida/index.html" "$salida/404.html"; do
  [ -f "$archivo" ] || continue
  grep -q 'name="robots"' "$archivo" || \
    sed -i.bak 's|<meta name="theme-color"|<meta name="robots" content="noindex, nofollow">\n<meta name="theme-color"|' "$archivo"
  rm -f "$archivo.bak"
done

# 4. El canonical de QA no debe apuntar a producción
sed -i.bak 's|https://www.fulbito.tech/|https://qa.fulbito.tech/|g' "$salida/index.html"
rm -f "$salida/index.html.bak"

# 5. Los leads de QA no van a la planilla de producción
sed -i.bak "s|var FORMSPREE_ENDPOINT = '[^']*';|var FORMSPREE_ENDPOINT = '';|" "$salida/script.js"
rm -f "$salida/script.js.bak"

# 6. La documentación no se publica, igual que en producción
find "$salida" -name '*.md' -delete

# 7. Los archivos de asociación de deep links son DISTINTOS por dominio
#
#    Ésta es la sustitución más fácil de olvidar y la que peor falla,
#    porque no rompe nada visible: el sitio se ve igual y los links
#    dejan de abrir la app, en silencio.
#
#    Ya pasó dos veces. La primera se descubrió el 2026-09-03 —QA
#    servía el assetlinks de producción, así que declaraba
#    `com.maudevarg.fulbito` en vez de `.qa` y `.dev`, y ningún flavor
#    de QA podía verificar—. Google resolvía los statements igual, así
#    que el dominio *parecía* verificado. Se corrigió, y el
#    regenerado del 2026-09-04 lo volvió a pisar: el script copiaba
#    todo y estos dos archivos no estaban en la lista de diferencias.
#
#    Los dos declaran QUÉ APP puede abrir los links del dominio:
#      - assetlinks.json  → package Android + huella de firma
#      - apple-app-site-association → appIDs de iOS
#
#    Producción declara `com.maudevarg.fulbito`; QA tiene que declarar
#    `.qa` y `.dev`, que son otros packages con otras firmas. Copiar
#    los de producción le da al app de PRODUCCIÓN permiso para
#    capturar links de QA: alguien abre una invitación de QA, se le
#    abre la app de producción, ésta consulta la API de producción y
#    responde "invitación no encontrada" por un token que vive en la
#    base de QA — sin ninguna pista del motivo.
#
#    La fuente de verdad de los cuatro archivos es el repo del app, en
#    docs/deep-links/well-known/<dominio>/. Si cambian allá, hay que
#    traerlos acá.
cp "$bien_conocido/assetlinks.json" "$salida/.well-known/assetlinks.json"
cp "$bien_conocido/apple-app-site-association" \
   "$salida/.well-known/apple-app-site-association"
echo "  .well-known de QA sustituido"

echo "Listo: $salida"
echo
echo "Para publicar:"
echo "  cd $salida"
echo "  git init -b main && git add -A && git commit -m 'deploy qa'"
echo "  git remote add origin https://github.com/maujpok/fulbito-qa"
echo "  git push -u --force origin main"

#!/usr/bin/env bash
#
# Prepara el checkout antes de publicarlo. Corre en el build del hosting.
#
# EXISTE POR UNA SOLA RAZÓN, Y ES LA IMPORTANTE
#
# Los archivos de .well-known/ declaran QUÉ APP puede abrir los links de un
# dominio. Producción declara com.maudevarg.fulbito; QA declara .qa y .dev, que
# son otros packages con otras firmas. TIENEN que ser distintos.
#
# El plan de migración reemplaza el repo duplicado de QA por dos ramas del
# mismo repo. Si la diferencia viviera en la rama, cada merge entre qa y main
# sería un conflicto sobre estos dos archivos — y alcanza con resolverlo mal
# UNA vez para reproducir la rotura de septiembre, que pasó dos veces y las dos
# en silencio: el sitio se ve igual y los links dejan de abrir la app.
#
# Así que las ramas quedan idénticas y la diferencia se aplica acá, en el
# build, mirando el entorno.
#
# Entorno: FULBITO_ENV si está; si no, la rama que el hosting expone en BRANCH.
#
set -euo pipefail

raiz="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$raiz"

entorno="${FULBITO_ENV:-}"
if [ -z "$entorno" ]; then
  case "${BRANCH:-${HEAD:-}}" in
    qa) entorno="qa" ;;
    *)  entorno="prod" ;;
  esac
fi

echo "prepare-deploy: entorno = $entorno"

# ---------------------------------------------------------------------------
# 🔴 NETLIFY NO DESPLIEGA CARPETAS QUE EMPIEZAN CON PUNTO
#
# Confirmado por su propio staff: ".well-known won't exist in the deploy as dot
# files are ignored". O sea que en Netlify el sitio quedaría SIN los archivos de
# deep links, y sin ningún error visible: la página se ve igual y los links
# dejan de abrir la app. Es exactamente la falla que este proyecto ya sufrió dos
# veces.
#
# La solución es servirlos desde una carpeta SIN punto y reescribir la ruta que
# busca el sistema operativo. El rewrite está en netlify.toml.
#
# ⚠️ El archivo servido sigue SIN extensión: lo que Apple pide es
#    /.well-known/apple-app-site-association, y eso no cambia. Acá sólo cambia
#    de dónde sale el contenido. NO renombrar a .json — ver deep-links/README.md.
#
# En GitHub Pages esto no hace falta: sirve la carpeta con punto sin problemas,
# y así funciona hoy. La copia extra es inofensiva en los dos hostings.
# ---------------------------------------------------------------------------
copia_visible() {
  mkdir -p deeplinks
  cp "$1" deeplinks/apple-app-site-association
  cp "$2" deeplinks/assetlinks.json
  echo "prepare-deploy: deep links copiados a deeplinks/ (Netlify ignora .well-known)"
}

if [ "$entorno" != "qa" ]; then
  copia_visible .well-known/apple-app-site-association .well-known/assetlinks.json
  echo "prepare-deploy: producción, nada más que hacer"
  exit 0
fi

# ---------------------------------------------------------------- QA --------

# La guarda va ANTES de tocar nada. Si fallara después de copiar, el directorio
# ya tendría los .well-known de PRODUCCIÓN adentro y alguien que ignore el
# error publicaría exactamente el sitio roto que la guarda venía a evitar.
for archivo in apple-app-site-association assetlinks.json; do
  if [ ! -f "deep-links/qa/$archivo" ]; then
    echo "ERROR: falta deep-links/qa/$archivo" >&2
    echo "       Sin eso QA quedaría declarando la app de PRODUCCIÓN y los" >&2
    echo "       deep links de QA dejarían de abrir la app, sin error visible." >&2
    echo "       Ver deep-links/README.md" >&2
    exit 1
  fi
done

cp deep-links/qa/apple-app-site-association .well-known/apple-app-site-association
cp deep-links/qa/assetlinks.json            .well-known/assetlinks.json
echo "prepare-deploy: .well-known de QA sustituido"

copia_visible deep-links/qa/apple-app-site-association deep-links/qa/assetlinks.json

# QA no se indexa. El header aplica a todo lo que sirve el sitio, no sólo al
# HTML; el robots.txt queda como segunda barrera.
cat > _headers <<'HDR'
/*
  X-Robots-Tag: noindex, nofollow
HDR
printf 'User-agent: *\nDisallow: /\n' > robots.txt
rm -f sitemap.xml
echo "prepare-deploy: QA marcado como noindex"

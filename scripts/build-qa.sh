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

echo "Listo: $salida"
echo
echo "Para publicar:"
echo "  cd $salida"
echo "  git init -b main && git add -A && git commit -m 'deploy qa'"
echo "  git remote add origin https://github.com/maujpok/fulbito-qa"
echo "  git push -u --force origin main"

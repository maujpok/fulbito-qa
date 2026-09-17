#!/usr/bin/env bash
#
# Verifica un sitio recién desplegado antes de mandarle tráfico real.
#
#   bash scripts/verificar-hosting.sh https://fulbito-prueba.netlify.app
#   bash scripts/verificar-hosting.sh https://qa.fulbito.tech  qa
#   bash scripts/verificar-hosting.sh https://www.fulbito.tech prod
#
# El segundo argumento dice qué app tiene que declarar el sitio. Si no se pasa,
# se deduce del hostname y, si no se puede, sólo se informa lo que encuentra.
#
# Corre la fase 0 entera del RUNBOOK_acciones_2026-09-15.md y además las
# verificaciones de las fases 2 y 3. Sale con 1 si algo CRÍTICO falla.
#
set -uo pipefail

base="${1:-}"
esperado="${2:-}"

if [ -z "$base" ]; then
  echo "uso: bash scripts/verificar-hosting.sh <URL> [prod|qa]" >&2
  exit 2
fi
base="${base%/}"

if [ -z "$esperado" ]; then
  case "$base" in
    *//www.fulbito.tech*|*//fulbito.tech*) esperado="prod" ;;
    *//qa.fulbito.tech*)                   esperado="qa" ;;
  esac
fi

fallas=0
avisos=0

ok()    { printf '  ✅ %s\n' "$1"; }
mal()   { printf '  ❌ %s\n' "$1"; fallas=$((fallas+1)); }
aviso() { printf '  ⚠️  %s\n' "$1"; avisos=$((avisos+1)); }

titulo() { printf '\n── %s\n' "$1"; }

codigo()   { curl -s -o /dev/null -w '%{http_code}' -m 25 "$1"; }
tipo()     { curl -s -o /dev/null -w '%{content_type}' -m 25 "$1"; }
cuerpo()   { curl -s -m 25 "$1"; }
redirect() { curl -s -o /dev/null -w '%{redirect_url}' -m 25 "$1"; }

# --------------------------------------------------------------- G2: deep links
titulo "G2 · los deep links  🔴 condición de corte"

aasa="$base/.well-known/apple-app-site-association"
links="$base/.well-known/assetlinks.json"

for u in "$aasa" "$links"; do
  c=$(codigo "$u")
  if [ "$c" = "200" ]; then ok "$(basename "$u") responde 200"
  else mal "$(basename "$u") responde $c — el host NO sirve /.well-known/"; fi
done

if [ "$(codigo "$aasa")" = "200" ]; then
  apps=$(cuerpo "$aasa" | python3 -c '
import sys, json
try:
    d = json.load(sys.stdin)
    ids = [i for x in d["applinks"]["details"] for i in x["appIDs"]]
    print(",".join(ids))
except Exception:
    print("ILEGIBLE")
' 2>/dev/null)

  case "$apps" in
    ILEGIBLE|"") mal "el AASA no es JSON válido" ;;
    *) ok "appIDs declarados: $apps"
       case "$esperado" in
         prod) case "$apps" in *".qa"*|*".dev"*) mal "PRODUCCIÓN está declarando la app de QA" ;;
                                              *) ok "declara la app de producción" ;; esac ;;
         qa)   case "$apps" in *".qa"*) ok "declara la app de QA" ;;
                               *) mal "QA está declarando la app de PRODUCCIÓN — es la falla que ya pasó dos veces" ;; esac ;;
       esac ;;
  esac

  comps=$(cuerpo "$aasa" | python3 -c '
import sys, json
d = json.load(sys.stdin)
print(" ".join(c["/"] for x in d["applinks"]["details"] for c in x["components"]))
' 2>/dev/null)
  ok "componentes: $comps"
  for esperada in /invite/player/ /invite/ /login/ "/group/*" /home "/home/*"; do
    case " $comps " in *" $esperada "*) : ;; *) mal "falta el componente $esperada" ;; esac
  done

  r=$(redirect "$aasa")
  [ -z "$r" ] && ok "sin redirección" || mal "redirige a $r — Apple no sigue redirecciones acá"

  t=$(tipo "$aasa")
  case "$t" in
    application/json*)         ok "Content-Type: $t" ;;
    application/octet-stream*) aviso "Content-Type: $t — Apple lo ingiere igual (medido). NO renombrar a .json" ;;
    *)                         aviso "Content-Type: $t" ;;
  esac

  case "$aasa" in *.json) mal "la URL termina en .json — Apple lo busca SIN extensión" ;; esac
fi

# ------------------------------------------------------------ G1: ruta dinámica
titulo "G1 · la ruta dinámica /p/"

pu="$base/p/?t=abc123token"
c=$(codigo "$pu"); t=$(tipo "$pu")
[ "$c" = "200" ] && ok "/p/?t= responde 200" || mal "/p/?t= responde $c"
case "$t" in text/html*) ok "Content-Type: $t" ;; *) mal "Content-Type: $t — se esperaba text/html" ;; esac

og=$(cuerpo "$pu" | grep -o '<meta property="og:title" content="[^"]*"' | head -1)
if [ -n "$og" ]; then
  case "$og" in
    *"Te invitaron a jugar un partido"*)
      aviso "tarjeta GENÉRICA — la función no corrió o la API no respondió a tiempo" ;;
    *) ok "tarjeta por partido: $og" ;;
  esac
else
  mal "no se encontró og:title"
fi

# ------------------------------------------------------------------ el resto
titulo "El resto del sitio"

for ruta in "/" "/invite/?t=abc123" "/group/?g=abc" "/login/"; do
  c=$(codigo "$base$ruta")
  [ "$c" = "200" ] && ok "$ruta → 200" || mal "$ruta → $c"
done

if [ "$esperado" = "qa" ]; then
  h=$(curl -s -I -m 25 "$base/" | grep -i '^x-robots-tag' | tr -d '\r')
  [ -n "$h" ] && ok "$h" || aviso "sin X-Robots-Tag: QA se podría indexar"
fi

if [ "$esperado" = "prod" ]; then
  c=$(codigo "https://fulbito.tech/"); r=$(redirect "https://fulbito.tech/")
  case "$c" in
    30*) ok "el ápex redirige ($c → $r)" ;;
    *)   mal "el ápex responde $c y no redirige — el ápex NO está en ALLOWED_ORIGINS de la API" ;;
  esac
fi

# ------------------------------------------------------------------- resumen
printf '\n'
if [ "$fallas" -gt 0 ]; then
  printf '❌ %s verificación(es) crítica(s) fallaron. NO sigas.\n' "$fallas"
  exit 1
fi
printf '✅ todo en orden'
[ "$avisos" -gt 0 ] && printf ' (%s aviso/s para mirar)' "$avisos"
printf '\n'

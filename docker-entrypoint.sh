#!/bin/sh
# Les volumes (data/ et public/uploads/) sont souvent montés depuis des
# dossiers de l'hôte créés par root (c'est le cas avec CasaOS, qui les crée
# dans /DATA/AppData/...). L'utilisateur "node" ne pourrait alors pas y
# écrire et le serveur planterait au démarrage. On corrige donc les droits
# en root, puis on lance le jeu en tant que "node" (jamais en root).
set -e

if [ "$(id -u)" = "0" ]; then
  mkdir -p /app/data /app/public/uploads
  chown -R node:node /app/data /app/public/uploads
  exec su-exec node "$@"
fi

# Conteneur déjà lancé avec un utilisateur non-root : on ne touche à rien.
exec "$@"

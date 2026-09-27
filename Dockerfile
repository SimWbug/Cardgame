# Clean Gang Decks — image Docker de production
#
# - Node 22 Alpine (léger), la version testée pendant tout le développement.
# - "npm ci --omit=dev" : installation reproductible depuis package-lock.json.
#   Déclenche scripts/vendor-three.js (postinstall), qui copie three.js dans
#   public/vendor/ pour la visionneuse 3D des cartes.
# - docker-entrypoint.sh corrige les droits des volumes montés (dossiers de
#   l'hôte souvent créés par root, ex. CasaOS), puis lance le jeu en tant
#   qu'utilisateur "node" : le process Node ne tourne jamais en root.
# - data/ et public/uploads/ sont des VOLUMES : une nouvelle version de
#   l'image ne touche jamais aux comptes, cartes et fichiers uploadés.
FROM node:22-alpine

RUN apk add --no-cache su-exec

WORKDIR /app

COPY package.json package-lock.json ./
COPY scripts ./scripts
COPY server.js ./
COPY src ./src
COPY public ./public

RUN npm ci --omit=dev \
 && mkdir -p data public/uploads/cards public/uploads/avatars public/uploads/sounds public/uploads/branding \
 && chown -R node:node /app

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENV PORT=3000
EXPOSE 3000

VOLUME ["/app/data", "/app/public/uploads"]

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "server.js"]

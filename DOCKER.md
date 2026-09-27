# Héberger Clean Gang Decks avec Docker

Ce guide suppose que Docker et Docker Compose sont déjà installés sur ta
machine ou ta VPS. Si ce n'est pas le cas :

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER   # puis reconnecte-toi (ou `newgrp docker`)
```

Docker Compose est inclus dans les installations récentes (`docker compose`,
sans tiret). Vérifie avec `docker compose version`.

## Démarrage rapide

```bash
cd clean-gang-decks-server
cp .env.example .env
nano .env        # change ADMIN_CODE — voir la section dédiée plus bas
docker compose up -d --build
```

Le jeu est alors sur `http://localhost:3000` (ou l'IP de ta VPS). Les logs :

```bash
docker compose logs -f
```

## Le code admin — à changer avant toute mise en ligne

`docker-compose.yml` lit `ADMIN_CODE` depuis un fichier `.env` à côté de lui
(jamais commité, comme les données elles-mêmes) :

```bash
cat > .env << 'EOF'
ADMIN_CODE=un-code-a-toi-different-de-admin123
EOF
```

Sans ce fichier, le code par défaut (`admin123`) est utilisé — pratique pour
tester en local, à éviter absolument dès que le port est exposé à internet.

## Ce qui survit à une mise à jour (et pourquoi)

`docker-compose.yml` déclare deux volumes nommés :

- `clean-gang-data` → `/app/data` (comptes, cartes, config admin, tout ce
  que gère `data/*.json`)
- `clean-gang-uploads` → `/app/public/uploads` (images et sons uploadés en
  admin)

Docker les garde **en dehors** de l'image du conteneur. Concrètement, ça
veut dire que la commande de mise à jour ci-dessous ne touche jamais à tes
données, même si elle reconstruit entièrement l'image :

```bash
git pull                        # ou : dézippe la nouvelle version par-dessus
docker compose up -d --build    # reconstruit l'image, relance le conteneur
```

C'est la même logique que le `.gitignore` déjà en place pour `git` — protéger
les données du code en les gardant dans des emplacements que la mise à jour
ne touche jamais, juste appliquée au niveau de Docker plutôt qu'au niveau
du système de fichiers.

## Sauvegarder les données

```bash
# Sauvegarde
docker run --rm -v clean-gang-data:/data -v clean-gang-uploads:/uploads \
  -v $(pwd):/backup alpine \
  tar czf /backup/clean-gang-backup-$(date +%Y%m%d).tar.gz /data /uploads

# Restauration (sur une installation vide)
docker run --rm -v clean-gang-data:/data -v clean-gang-uploads:/uploads \
  -v $(pwd):/backup alpine \
  tar xzf /backup/clean-gang-backup-20260927.tar.gz -C /
```

## Sans docker-compose (commandes Docker directes)

Si tu préfères ne pas utiliser Compose :

```bash
docker build -t clean-gang-decks .

docker volume create clean-gang-data
docker volume create clean-gang-uploads

docker run -d --name clean-gang-decks \
  --restart unless-stopped \
  -p 3000:3000 \
  -e ADMIN_CODE=un-code-a-toi \
  -v clean-gang-data:/app/data \
  -v clean-gang-uploads:/app/public/uploads \
  clean-gang-decks
```

## Accès HTTPS avec un nom de domaine (nginx + certbot, en dehors du conteneur)

Le conteneur n'écoute qu'en HTTP sur le port 3000 — pour du HTTPS propre
avec un domaine, on met nginx **devant** le conteneur, sur la machine hôte
(pas besoin de le mettre dans Docker) :

```nginx
server {
    listen 80;
    server_name jeu.tondomaine.fr;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

Puis `sudo certbot --nginx -d jeu.tondomaine.fr` comme pour un déploiement
sans Docker — cette partie ne change pas.

## Dépannage

**Le conteneur redémarre en boucle** : `docker compose logs` pour voir
l'erreur exacte. Le cas le plus courant est un port 3000 déjà occupé sur
la machine hôte — change le mapping dans `docker-compose.yml` (par exemple
`"8080:3000"` pour exposer sur le port 8080 à la place).

**La visionneuse 3D des cartes ne s'affiche pas** : vérifie que
`/vendor/three/three.module.js` répond bien (`curl -I` depuis le
conteneur ou l'hôte) — ce fichier est généré automatiquement à la
construction de l'image par `scripts/vendor-three.js`, il ne devrait
jamais manquer avec ce Dockerfile.

**Je veux repartir de zéro** (efface aussi les données, à utiliser en
connaissance de cause) :

```bash
docker compose down -v
```

Le `-v` supprime aussi les volumes nommés — sans lui, `docker compose down`
seul arrête et retire le conteneur mais garde les volumes (donc les
données) intacts pour un futur `docker compose up`.

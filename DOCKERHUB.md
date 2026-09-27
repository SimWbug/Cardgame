# Publier Clean Gang Decks sur Docker Hub (puis l'installer via CasaOS)

Une fois l'image publiée sur Docker Hub, le formulaire d'installation de
CasaOS suffit : plus besoin de terminal sur le serveur.

## 1. Préparer Docker Hub (une seule fois)

1. Crée un compte sur https://hub.docker.com (gratuit). Ton pseudo Docker
   Hub sera dans le nom de l'image : `TON_PSEUDO/clean-gang-decks`.
2. Va dans **Account settings → Personal access tokens → Generate new
   token**, donne-lui les droits **Read & Write**, et copie le token (il ne
   s'affiche qu'une fois).

L'image sera publique. Elle ne contient rien de secret : le code admin est
passé en variable d'environnement au lancement, et les comptes/cartes
restent dans les volumes de ton serveur, jamais dans l'image.

## 2a. Publication automatique avec GitHub (recommandé)

Le fichier `.github/workflows/docker-publish.yml` est déjà dans le projet.

1. Dans ton dépôt GitHub : **Settings → Secrets and variables → Actions →
   New repository secret**, crée ces deux secrets :
   - `DOCKERHUB_USERNAME` : ton pseudo Docker Hub
   - `DOCKERHUB_TOKEN` : le token copié à l'étape 1
2. Pousse le code sur la branche `main` :
   ```bash
   git add -A
   git commit -m "Publication Docker Hub"
   git push
   ```
3. Onglet **Actions** du dépôt : le workflow « Publier sur Docker Hub »
   tourne (5 à 10 minutes la première fois). Quand il est vert, l'image
   est en ligne.

Ensuite, chaque `git push` sur `main` republie automatiquement l'image.
L'image est construite pour **amd64 et arm64** : elle fonctionne sur un PC,
une VPS, une ZimaBoard ou un Raspberry Pi.

## 2b. Publication manuelle depuis ton PC (sans GitHub)

Il faut **Docker Desktop** installé sur ton PC. Dans un terminal, depuis le
dossier du projet :

```bash
docker login -u TON_PSEUDO
# colle le token quand le mot de passe est demandé

docker buildx create --use
docker buildx build --platform linux/amd64,linux/arm64 \
  -t TON_PSEUDO/clean-gang-decks:latest --push .
```

Sous PowerShell (Windows), remplace les `\` de fin de ligne par des
accents graves `` ` ``, ou mets tout sur une seule ligne.

## 3. Installer dans CasaOS avec le formulaire

Dans CasaOS : **App Store → Installation personnalisée**, puis remplis :

| Champ | Valeur |
|---|---|
| Image Docker | `TON_PSEUDO/clean-gang-decks` |
| Tag | `latest` |
| Titre | `Clean Gang Decks` |
| Web UI | `http://` · `192.168.1.20` · port `3000` · `/` |
| Réseau | `bridge` |

**Ports** → Ajouter :

| Hôte | Conteneur | Protocole |
|---|---|---|
| `3000` | `3000` | TCP |

**Volumes** → Ajouter (deux lignes) :

| Hôte | Conteneur |
|---|---|
| `/DATA/AppData/clean-gang-decks/data` | `/app/data` |
| `/DATA/AppData/clean-gang-decks/uploads` | `/app/public/uploads` |

**Variables d'environnement** → Ajouter :

| Clé | Valeur |
|---|---|
| `ADMIN_CODE` | ton code admin secret |

Laisse le reste par défaut et clique sur **Installer**. Le jeu est ensuite
sur `http://192.168.1.20:3000`.

Les dossiers `/DATA/AppData/...` sont créés par CasaOS avec le compte root.
Le script d'entrée de l'image (`docker-entrypoint.sh`) corrige leurs droits
au démarrage, puis lance le jeu avec un utilisateur non-root : pas de
manipulation à faire de ton côté.

Si le port 3000 est déjà pris sur ton serveur, mets un autre port côté
**Hôte** (par exemple `3010`) et garde `3000` côté **Conteneur**.

## 4. Mettre à jour le jeu

1. Publie la nouvelle version (un `git push` si tu utilises GitHub, sinon
   refais l'étape 2b).
2. Dans CasaOS, ouvre les paramètres de l'appli et relance-la en
   récupérant la dernière image (selon la version de CasaOS : bouton de
   mise à jour, ou « Rebuild »/réinstallation avec le même formulaire).

Les comptes, cartes et fichiers uploadés sont dans `/DATA/AppData/clean-gang-decks/`
sur le serveur : une mise à jour de l'image n'y touche jamais.

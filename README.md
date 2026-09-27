# Clean Gang Decks — TCG multijoueur (Node.js)

Un jeu de cartes à collectionner façon **Hearthstone** : deck de 30 cartes, mana
croissant, Provocation, Charge, sorts de soin et de zone. Avec collection,
boosters, poussière, échanges, amis, défis, classement mensuel et boutique
d'ornements.

## Installation

Il faut [Node.js](https://nodejs.org) 18 ou plus récent.

```bash
npm install
npm start
```

Ouvre **http://localhost:3000**. Pour tester un combat, ouvre la même adresse
dans une fenêtre de navigation privée (ou sur un autre appareil du réseau) et
crée un second compte.

### Vérifier que tout fonctionne

```bash
npm test            # moteur de combat + clôture de saison (sans serveur)
npm run test:live   # serveur déjà lancé : inscription, poussière, amis,
                    # défi, combat complet et attribution des points
```

## Le jeu en bref

| Onglet | Ce qu'on y fait |
|---|---|
| **Collection** | Tes cartes, ton profil, ton rang, ton avatar et ta roue de provocations |
| **Codex** | Progression de collection par extension et au total, cumulative pour toujours |
| **Boosters** | 5 cartes toutes les 10 min, ouverture animée en 3D |
| **Deck** | Construire ton deck de 30 cartes |
| **Combat** | File d'attente aléatoire, ou défier un ami connecté |
| **Classement** | Classement de la saison en cours + podiums passés |
| **Poussière** | Désenchanter les exemplaires en trop |
| **Boutique** | Ornements, provocations et boosters, payables en crédits et/ou poussière |
| **Joueurs** | Voir les collections, ajouter des amis, proposer des échanges |
| **Échanges** | Accepter / refuser / annuler les demandes |
| **Admin** | Cartes (serviteurs, armes, sorts), extensions, ornements personnalisés, provocations, comptes, et combat de test contre un bot (code par défaut : `admin123`) |

## Économie

**Taux de drop des boosters** : commun 60%, rare 25%, épique 12%, **légendaire 3%**.

**Poussière** — les exemplaires au-delà de la limite jouable (2 copies, 1 pour
les légendaires) peuvent être désenchantés :

| Rareté | Poussière |
|---|---|
| Commun | 1 |
| Rare | 2 |
| Épique | 10 |
| Légendaire | 250 |

Autres sources : **20 ✧ par victoire**, et le podium mensuel (voir ci-dessous).

**Ornements** (60 à 1500 ✧) — modifiables dans `src/cards.js`, tableau `ORNAMENTS`.
Les prix sont calés sur ces revenus : le premier ornement s'obtient en 3 victoires
environ. Si tu trouves ça trop lent ou trop rapide, c'est la première valeur à ajuster.



## Taux de drop personnalisé et armure

Depuis l'onglet **Admin → Cartes**, à la création :

- **Boutons de rareté** — cliquer sur Commun/Rare/Épique/Légendaire fixe la
  rareté et affiche le taux standard estimé (partagé équitablement entre les
  cartes de cette rareté).
- **Personnaliser le taux de drop** — une case à cocher révèle un champ
  « poids de tirage » (0,05 à 20 ; 1 = comme les autres cartes de sa rareté).
  L'estimation en % se met à jour en direct. Modifiable après coup sur
  n'importe quelle carte du pool (champ + bouton « Fixer »).
- Important : cela ne change **que la répartition à l'intérieur d'une
  rareté**. Le taux global reste commun 60% / rare 25% / épique 12% /
  **légendaire 3%**, garanti par les tests.

**Armure** (serviteurs uniquement) — absorbe les dégâts avant les points de
vie, point pour point, avant de laisser passer le reste vers les PV.

**Nouveaux effets de sort** :
- Dégâts à **tous** les serviteurs en jeu (les deux camps)
- Bonus d'attaque à **tous vos** serviteurs
- **Destruction totale** du plateau (les deux camps, armure ignorée)
- Effet combiné : bonus d'attaque à un allié **+ soin du héros** en un seul sort


## Cartes en 3D (Three.js)

Deux endroits utilisent un vrai rendu 3D via **Three.js** :

- **Visionneuse 3D** — le bouton 🧊 sur n'importe quelle vignette (Collection,
  Deck, Admin, collection d'un autre joueur) ouvre une carte en 3D dans une
  modale : glisse pour la faire pivoter, rotation automatique au repos.
- **Ouverture de booster** — les 5 cartes apparaissent en 3D et se retournent
  une à une.

**Comment ça marche** : `public/card3d.js` compose chaque carte (image,
texte, statistiques) sur un canvas 2D, utilisé comme texture sur un pavé 3D
(un peu d'épaisseur, comme une vraie carte). Les rangs épique et légendaire
ont un matériau plus métallique et une légère émission lumineuse.

**Un seul contexte WebGL pour tout le jeu.** Chaque contexte WebGL est une
ressource limitée du navigateur (une dizaine en simultané, grand maximum).
Faire une carte 3D par vignette dans une grille de 50 cartes aurait cassé
cette limite — le jeu garde donc un seul renderer partagé, déplacé dans le
DOM selon ce qu'il doit afficher.

**Pourquoi les grilles (Collection, Deck, Admin) restent en 2D.** Afficher
des dizaines de cartes en 3D simultanément n'est pas réaliste en performance
avec un seul contexte partagé — chaque carte prend son tour dans la
visionneuse au clic, plutôt que toutes en même temps dans la grille. Les
cartes en main et sur le plateau pendant un combat restent aussi en 2D
rapide, pour ne pas ralentir le jeu ni gêner les clics de ciblage.

**Repli automatique.** Si le navigateur ne supporte pas WebGL, le jeu continue
normalement : la visionneuse affiche un message d'erreur discret, et
l'ouverture de booster retombe sur une simple grille sans animation.

**Limite honnête à connaître** : je n'ai pas pu tester le rendu visuel réel
dans un navigateur depuis cet environnement de développement — seule la
logique (cycle de vie, fuite mémoire GPU) a été vérifiée avec un faux
Three.js (`test-card3d.js`). Vérifie toi-même que l'affichage te convient à
l'usage, et remonte-moi tout souci de rendu.




## Glisser-déposer une carte (façon Hearthstone)

En combat, une carte jouable dans ta main se **saisit et se glisse** vers le
plateau, avec une inclinaison 3D qui suit le curseur pendant le geste (comme
dans Hearthstone) :

- Saisis la carte et lève-la au-dessus de ta main : elle se soulève, s'incline
  selon le déplacement horizontal, et grossit légèrement.
- La zone de pose (ton plateau) s'illumine en vert dès que la carte est levée
  assez haut.
- Relâche au-dessus de cette zone pour jouer la carte (mêmes règles qu'avant :
  un serviteur se pose directement, un sort qui a besoin d'une cible passe en
  mode ciblage).
- Relâche ailleurs (ou sans avoir assez levé la carte) : elle revient
  glisser à sa place dans la main, sans être jouée.

**Le simple clic fonctionne toujours** — un mouvement minime suivi d'un
relâchement rejoue exactement l'ancien comportement (jeu immédiat). Le
glisser n'est qu'un geste supplémentaire, pas un remplacement obligatoire :
utile sur mobile ou pour qui préfère la rapidité du clic.

**Limite connue** : si un événement extérieur (par exemple une provocation
envoyée par l'adversaire) déclenche un rafraîchissement de l'écran pendant que
tu es activement en train de glisser une carte, l'emplacement vide qu'elle
laissait dans ta main peut réapparaître visuellement avant que tu relâches —
purement cosmétique, ça n'affecte jamais le résultat de l'action.


## Choix de la main de départ (mulligan)

Chaque combat démarre par un écran de sélection, comme dans Hearthstone :
les deux joueurs voient leur main de départ (4 cartes) et peuvent cliquer
sur celles qu'ils veulent **remplacer** — elles retournent dans la pioche
(mélangée à nouveau) et sont remplacées par de nouvelles cartes piochées au
hasard. Aucun mana n'est distribué et aucune action de jeu n'est possible
tant que les deux joueurs n'ont pas validé.

- Contre le bot d'entraînement, celui-ci valide sa main automatiquement
  (il garde les cartes à moins de 5 de coût) dès que tu valides la tienne.
- En PvP, si tu valides avant ton adversaire, un message d'attente
  s'affiche le temps qu'il fasse son choix.

## Interface de combat façon Hearthstone

Le plateau a été redessiné pour se rapprocher visuellement de Hearthstone :

- **Points de vie du héros** affichés dans un médaillon rouge superposé au
  portrait, plutôt qu'une pastille de texte à côté.
- **Mana** affiché en rangée de cristaux (pleins pour le mana disponible,
  éteints pour le mana déjà dépensé ce tour-ci), plutôt qu'un simple "X/Y".
- **Serviteurs en portraits circulaires**, avec l'attaque (gemme jaune) et
  les PV (gemme rouge) qui débordent du cercle, comme sur le plateau
  Hearthstone.
- **Cartes de la main agrandies** (172×238px) pour que l'illustration soit
  enfin bien visible, plus grande zone d'art.
- **Bouton de fin de tour** repositionné en cercle doré sur le bord droit
  du plateau (grand écran), avec texte vertical.
- Plateau aux bords biseautés et dégradés pour évoquer une table de jeu.

**Limite honnête, comme pour la 3D et les animations** : je n'ai pu vérifier
ce relookage que par lecture de code et cohérence CSS, jamais par un rendu
réel dans un navigateur. Si quelque chose ne tombe pas juste visuellement
(alignement, taille, lisibilité), décris-le-moi précisément et je corrige
sans tout reprendre.

## Codex de collection

Onglet **Codex** : suivi de progression, par extension et au total. Une carte
une fois obtenue (booster gratuit, booster acheté, ou reçue lors d'un
échange) **reste marquée comme découverte pour toujours**, même si tu la
désenchantes ensuite ou que tu l'échanges contre autre chose. Les cartes
jamais obtenues apparaissent verrouillées, en niveaux de gris, sans révéler
leur nom ni leurs statistiques.

## Ornements personnalisés (Admin)

En plus des ornements CSS déjà intégrés (Bronze, Argent, Or, Halo Arcanique...),
l'onglet **Admin → Ornements** permet d'ajouter des ornements en **image PNG**
(fond transparent recommandé) avec leur propre nom et prix en poussière. Si un
ornement est supprimé, les joueurs qui l'avaient équipé retombent
automatiquement sur "Aucun".

## Interface de combat premium

Le combat a été entièrement repensé :

- **Plein écran pendant la partie** — la barre latérale (boutique, collection...)
  disparaît le temps du combat pour une vue immersive, centrée sur le plateau.
- **Animations pilotées par différence d'état** — à chaque mise à jour reçue du
  serveur, le client compare l'état précédent au nouveau pour savoir
  précisément ce qui a changé (un serviteur posé, une attaque, des dégâts, un
  soin, une mort), et n'anime que ça — pas tout le plateau à chaque fois.
  - Un serviteur posé apparaît avec un effet d'entrée.
  - Une carte qui attaque fait un mouvement vers sa cible.
  - Le héros **tremble et vire au rouge** en prenant des dégâts (vert pour un
    soin), avec un nombre flottant (`-X` / `+X`).
  - Un serviteur qui meurt se désagrège avant de disparaître, plutôt que de
    s'effacer d'un coup.
- **Bouton Abandonner** pendant un combat actif — jusque-là, il n'y avait
  aucun moyen propre de quitter une partie en cours sans fermer l'onglet ;
  l'adversaire remporte la partie normalement.
- Respecte `prefers-reduced-motion` : toutes ces animations se coupent
  automatiquement pour qui a désactivé les animations dans son système.

**Limite honnête** : comme pour la 3D, je n'ai pu tester ces animations que
par leur logique (quel changement d'état déclenche quelle classe CSS) et par
lecture de code, pas par un rendu réel dans un navigateur. Le fichier
`test-combat-anim.js` vérifie la logique de détection ; vérifie toi-même le
rendu visuel à l'usage.


## Corrections d'interface (retour de test)

- **Provocations** : les bulles s'affichent maintenant bien à côté de l'avatar
  concerné (elles apparaissaient en haut de l'écran par erreur, faute d'un
  ancrage de positionnement correct).
- **Cartes en main** : la description est de nouveau visible (elle avait
  disparu lors de l'agrandissement des cartes), à la fois en combat et sur
  l'écran de mulligan.
- **Clic vs glisser** : cliquer une carte sans la glisser ouvre maintenant sa
  fiche en **3D** (nom, stats, description bien lisibles) au lieu de la jouer
  directement. Pour jouer une carte, il faut la **glisser jusqu'au plateau** —
  cohérent avec le geste de glisser-déposer.
- **Logo** : la sidebar n'affiche plus que le logo Clean Gang Decks, sans texte
  redondant à côté (le nom est déjà dans le logo).
- **Icône crédits** : remplacée par une pièce 🪙 pour ne plus être confondue
  avec l'icône de poussière ✧.






## Onglet Événements (casino et boss)



Nouvel onglet **Événements**, invisible par défaut — l'admin doit l'activer
depuis **Admin → Événements** pour qu'il apparaisse dans le menu. Deux
mini-jeux indépendamment activables :

### 🎰 Casino
Une machine à sous à 3 rouleaux où les joueurs misent de la poussière. Chaque
tour coûte un montant réglable par l'admin ; aligner 3 symboles identiques
rapporte un gain (mise × multiplicateur du symbole). L'admin règle :
- Le coût par tour
- Le poids de tirage de chacun des 5 symboles (plus haut = plus fréquent)
- Le gain de chaque symbole en cas d'alignement des 3

### 👹 Boss
Un combat contre un boss personnalisé, **une tentative par joueur et par
jour** — consommée dès le lancement du combat, pas seulement en cas de
victoire (impossible de relancer aussitôt après une défaite). Réutilise
entièrement le moteur de combat existant (deck, mulligan, armes, tout) via
la même infrastructure que le bot d'entraînement. L'admin règle :
- Nom et image du boss
- Ses points de vie (indépendants des 30 PV standards)
- La récompense de victoire (poussière et/ou crédits)

Un combat de boss **ne compte jamais pour le classement saisonnier** (ni
victoires, ni points), seulement pour la récompense de l'événement.

**Un vrai bug trouvé en branchant l'affichage** : les combats de boss
héritent techniquement du même indicateur "combat de bot" que les combats de
test admin (pour éviter tout impact sur le classement) — la bannière de fin
de combat affichait donc à tort "Combat de test — aucune récompense" même
après une victoire de boss avec une vraie récompense. Corrigé en distinguant
explicitement les deux cas côté client.




## Images d'interface personnalisables (Admin → Contenu)

Au-delà du logo, l'admin peut maintenant uploader quatre autres images
d'ambiance depuis Admin → Contenu, chacune avec sa **taille recommandée en
pixels** affichée directement à côté du bouton d'upload, pour tomber juste
du premier coup :

| Image | Où elle s'affiche | Taille recommandée |
|---|---|---|
| Fond du plateau de combat | Derrière le plateau, en plein écran pendant un combat | 1600×1000 px |
| Fond de l'écran de connexion | Toute la page derrière le formulaire de connexion | 1920×1080 px |
| Fond du menu latéral | Texture verticale derrière les boutons du menu | 300×1200 px |
| Texture des panneaux | Motif répété en fond de chaque encadré de l'application | 512×512 px |

Une seule feuille de style est injectée dynamiquement pour appliquer ces
images (plutôt que de modifier chaque endroit du code où un panneau
apparaît), toujours synchronisée avec le contenu chargé.

**Deux vrais trous trouvés en construisant cette fonctionnalité, pas des
bugs de ce tour-ci mais hérités d'un travail précédent** :
1. La route publique `/api/content` ne renvoyait que le logo et le fond du
   plateau, codés en dur — n'importe quelle nouvelle image ajoutée au
   registre n'aurait jamais atteint le client, même correctement uploadée
   et stockée. Corrigée pour renvoyer tous les emplacements dynamiquement.
2. Le fond du plateau de combat (`boardBackground`) faisait déjà partie du
   système depuis une session précédente, mais **n'était jamais appliqué
   nulle part visuellement** — la possibilité d'uploader une image existait
   sans que rien ne s'en serve. Corrigé en même temps que les nouveaux
   emplacements.










## Docker Hub et CasaOS

Voir **DOCKERHUB.md** : publication de l'image sur Docker Hub (automatique
via GitHub Actions, ou manuelle depuis un PC avec Docker Desktop), puis
installation par le formulaire « Installation personnalisée » de CasaOS.

L'image utilise désormais `docker-entrypoint.sh` : les volumes montés depuis
l'hôte sont souvent créés par root (c'est le cas avec CasaOS dans
`/DATA/AppData/`), ce qui aurait empêché l'utilisateur `node` d'y écrire et
fait planter le serveur au démarrage. Le script corrige les droits de ces
deux dossiers, puis lance le jeu en tant que `node` (jamais en root).

## Docker

Un `Dockerfile` et un `docker-compose.yml` sont fournis pour héberger le
jeu en conteneur — voir **DOCKER.md** pour le guide complet (démarrage
rapide, code admin, sauvegardes, HTTPS).

**Correctif au passage** : `public/vendor/three/three.module.js`
(nécessaire à la visionneuse 3D des cartes, chargé par le navigateur via
l'importmap de `public/index.html`) manquait dans les livraisons
précédentes — la visionneuse 3D était donc cassée dès une installation
fraîche. Corrigé avec `scripts/vendor-three.js`, un script `postinstall`
qui copie automatiquement ce fichier depuis `node_modules/three` à chaque
`npm install`, pour rester synchronisé avec la version exacte déclarée
dans `package.json` sans avoir à le committer.

## Effet parallaxe sur les cartes (visionneuse 3D uniquement)

Une carte peut recevoir un effet de relief visible uniquement dans la
visionneuse 3D (jamais en main, sur le plateau, ou dans les grilles — ces
vues 2D continuent d'utiliser l'image de carte normale). Dans Admin →
Cartes, une case "Effet parallaxe" à la création ou à l'édition révèle deux
emplacements d'image : **fond** et **personnage**. Les deux sont
nécessaires ensemble — un parallaxe à moitié rempli reste silencieusement
désactivé plutôt que de produire un rendu à moitié cassé.

Techniquement : les deux images sont superposées à des profondeurs
différentes devant la carte, alignées sur la même zone que l'illustration
habituelle. Comme elles tournent toutes deux avec la carte mais sont à des
distances différentes de l'axe de rotation, elles se décalent différemment
l'une de l'autre pendant la rotation ou le glisser — c'est ce décalage
relatif qui donne l'impression de profondeur, pas un filtre appliqué après
coup. Le **fond est rendu environ 18% plus grand** (zoomé) que le
personnage : à profondeur et taille égales, l'effet de parallaxe est presque
invisible à l'œil — le zoom accentue nettement la sensation d'un vrai
arrière-plan qui s'étend au-delà du cadre.

**Filet de sécurité, suite à un vrai trou remonté par l'usage** : une
carte à parallaxe qui n'a pas d'image fixe séparée réutilise automatiquement
le calque "personnage" comme image 2D (main, plateau, grilles). Avant ce
correctif, une carte créée avec seulement les calques du parallaxe
n'affichait rien du tout en dehors de la visionneuse 3D — le champ "Image de
la carte" restait vide si l'admin ne pensait pas à le remplir séparément.
Le formulaire admin le rappelle désormais explicitement.

**Un vrai bug trouvé en relisant mon propre code, avant même de le
tester** : ma première version de la sauvegarde d'édition ne permettait de
réactiver le parallaxe qu'en re-uploadant au moins un des deux calques —
réactiver une carte qui avait déjà ses deux images (juste désactivée
entre-temps), sans rien re-uploader, ne fonctionnait pas. Corrigé avant
livraison.

**Changement technique notable** : une carte à parallaxe devient un `Group`
Three.js (le corps de la carte + les 2 calques) plutôt qu'un `Mesh` simple.
La fonction de libération mémoire GPU (`disposeMesh`) a dû devenir
récursive pour continuer à libérer correctement les deux types de cartes,
sans quoi chaque carte à parallaxe affichée aurait fui de la mémoire vidéo
au lieu d'être nettoyée à la fermeture de la visionneuse.

**Historique** : une première version proposait 3 calques (fond, personnage,
premier plan). Simplifiée à 2 calques (fond, personnage) à l'usage — plus
simple à préparer côté admin, et le zoom du fond suffit à donner l'effet de
profondeur recherché sans un troisième calque.

## Grand écran de victoire / défaite

À la fin d'une partie, un grand texte ("VICTOIRE", "DÉFAITE" ou "ÉGALITÉ")
s'affiche par-dessus tout le plateau, avec une animation d'entrée différente
selon le cas (rebond triomphant en or pour une victoire, chute plus sourde en
rouge pour une défaite). Il s'efface automatiquement après 2,6 secondes, ou
immédiatement au clic pour voir tout de suite la bannière de récompenses en
dessous. Le résultat est calculé par rapport au joueur qui regarde (pas un
champ brut), donc chaque joueur voit bien SON propre résultat, jamais celui
de son adversaire.

## Packs de crédits, enfin visibles dans la boutique

Ce n'était pas une disparition : les packs de crédits (poussière → crédits)
avaient été construits entièrement côté serveur (moteur, routes, tests) lors
d'une session précédente, mais **jamais réellement branchés côté client** —
ni dans la boutique, ni dans le panel admin. Ils n'ont jamais été visibles,
nulle part.

Corrigé : un nouvel onglet "Crédits" dans la boutique liste les packs
disponibles et permet de les acheter, et Admin → Extensions permet
maintenant de créer, modifier et supprimer des packs (nom, crédits donnés,
prix en poussière).




## Parallaxe : un vrai cadre, pas deux images qui flottent

Après un premier essai jugé "nul" une fois vu à l'usage, revu en profondeur :
les deux calques (fond, personnage) sont maintenant **découpés par un cadre**
qui correspond exactement au rectangle d'illustration de la carte, plutôt que
d'être deux plans qui débordaient librement dans l'espace. Le personnage
reste visuellement "collé" à ce cadre, le fond (plus loin, plus grand) semble
bouger derrière — exactement l'effet de fenêtre demandé.

Techniquement : quatre plans de découpe (`THREE.Plane`, un par bord du
cadre) sont recalculés en repère MONDE à **chaque image**, d'après la
rotation actuelle de la carte — sans ça, le cadre serait resté figé face
caméra pendant que la carte tourne, et le fond aurait débordé visiblement
dès que la carte pivote. Vérifié avec le vrai module three.js (maths pures,
sans rendu) : la normale d'un plan tourne bien de 90° quand la carte tourne
de 90°, preuve numérique directe que le cadre suit vraiment la rotation.


## Parallaxe : le cadre rendu plus robuste, profondeur réduite

Après un retour montrant l'image qui débordait largement de la carte : la
mécanique du cadre de découpe elle-même a été revérifiée intégralement en
lisant le code source réel de three.js (pas juste la documentation) — le
mécanisme est correct sur le papier. Deux ajustements par prudence quand
même :

- **Réaffectation complète des plans à chaque image**, plutôt que de muter
  les plans existants en place — pour écarter tout doute sur un éventuel
  effet de cache interne du moteur de rendu qui n'aurait pas repris une
  mutation d'un objet déjà référencé.
- **Profondeur réduite** (0,04 / 0,30 au lieu de 0,05 / 0,55) : à une
  distance de caméra aussi rapprochée, pousser un calque très loin devant la
  carte l'agrandit aussi par effet de perspective (plus proche de la
  caméra = perçu plus grand) — un effet de bord qui accentuait le débordement
  visible sur la capture partagée. Toujours nettement plus marqué que le
  tout premier réglage (quasi imperceptible), mais sans pousser la
  perspective à l'extrême.

Le test de l'écart de profondeur (`test-parallax-3d.js`) a lui-même montré
une vraie faiblesse au passage : il ne faisait qu'un simple `console.log`
plutôt qu'un `assert`, donc il aurait pu afficher un ❌ sans jamais faire
échouer la suite. Corrigé pour devenir réellement contraignant.






## Parallaxe : la transparence du personnage, perdue puis retrouvée

Après avoir corrigé l'ordre d'affichage (personnage derrière le fond), un
nouveau retour a montré un fond noir plein à la place du détourage attendu
du personnage. La cause : en rendant les calques opaques pour corriger
l'ordre d'affichage, `transparent: true` avait disparu — sans lui, WebGL
ignore complètement le canal alpha de l'image et affiche du noir plein là
où le personnage devrait laisser voir le fond derrière lui lui. Un
personnage sans zone transparente autour de sa silhouette n'a d'ailleurs
aucune raison d'avoir un calque de fond séparé — la transparence est le
principe même de l'effet à deux calques.

**Le bon réglage, qui corrige les deux problèmes à la fois** :
`transparent: true` restauré (le détourage laisse à nouveau voir le fond),
avec `depthWrite: false` qui l'accompagne (pratique standard pour du
transparent). Ce réglage laisse Three.js trier automatiquement les objets
transparents du plus loin au plus proche de la caméra avant de les peindre
— ce qui règle AUSSI l'ordre d'affichage entre fond et personnage, plus
fiablement qu'un test de profondeur classique (qui ne sait de toute façon
pas gérer une transparence partielle).

## Parallaxe : le vrai bug — le personnage s'affichait derrière le fond

Grâce à un schéma annoté très clair, la cause exacte est apparue : le
personnage se retrouvait affiché DERRIÈRE le fond, pas devant. La cause :
les calques fond/personnage sont opaques (pas de transparence) depuis le
passage à la composition par canvas, mais gardaient `depthWrite: false` —
un réglage hérité d'une version précédente où ils étaient transparents (là
où c'est la bonne pratique, pour éviter des soucis de tri entre objets
transparents). Sur des calques opaques, ce réglage casse le test de
profondeur normal : l'ordre d'affichage entre fond et personnage devenait
imprévisible plutôt que de suivre leur vraie position en Z. Corrigé en
laissant `depthWrite` à sa valeur normale (actif) sur ces deux calques —
seul le contour d'ombre (qui, lui, est bien transparent) garde
`depthWrite: false`.

Une vérification dédiée a été ajoutée pour que cette régression précise ne
puisse plus repasser inaperçue.

## Parallaxe : changement de technique après un débordement persistant

Deux captures montrant un débordement massif et clairement confirmé — le
personnage et le fond flottant nettement en dehors de la carte, pas juste un
léger décalage. La mécanique précédente (des plans agrandis en 3D, découpés
par des `THREE.Plane` suivant la rotation de la carte) était mathématiquement
correcte — vérifiée à trois reprises avec le vrai module three.js — mais
manifestement peu fiable en pratique, pour une raison que je n'ai pas pu
identifier avec certitude sans accès à un navigateur réel.

**Changement d'approche plutôt que nouvelle tentative de rustine** : les
deux calques (fond, personnage) sont maintenant chacun composés sur un petit
canvas redimensionné à la taille EXACTE du cadre de la carte, avec l'image
recadrée façon "object-fit: cover" (elle remplit tout le canvas, ce qui
dépasse est simplement hors cadre, jamais dessiné). Le "zoom" du fond, qui se
faisait avant en agrandissant le plan 3D lui-même, se fait maintenant en
zoomant DANS l'image avant recadrage. Résultat : le plan 3D final fait
toujours exactement la taille du cadre, ni plus ni moins — plus aucun plan
de découpe 3D nécessaire. Ce n'est plus une question de bon fonctionnement
d'une fonctionnalité WebGL avancée, mais une contrainte géométrique de base :
un plan ne peut pas déborder d'un cadre auquel il est dimensionné à
l'identique.

**Test renforcé en conséquence** : plutôt que de vérifier la géométrie du
plan de découpe (le mécanisme abandonné), le test vérifie maintenant
directement que le canvas de composition est bien redimensionné au ratio
exact du cadre, et que les deux calques ont une géométrie strictement
identique en taille — la garantie recherchée, prouvée à la source plutôt que
supposée correcte.

## Parallaxe : le personnage resserré contre la carte, plus d'effet de survol

Retour précis après le contour d'ombre : le personnage restait perçu comme
"en survol" plutôt que vraiment posé. En reconsidérant la profondeur
utilisée jusque-là (0,04 pour le fond, 0,30 pour le personnage), la relation
était en fait inversée par rapport à l'intuition : c'est le personnage qui
était poussé le PLUS loin devant la carte, largement plus que le fond — donc
lui, précisément, qui flottait le plus. Resserré à 0,03/0,09 (le personnage
reste maintenant tout près de la surface de la carte, comme une vraie
illustration), le contour d'ombre suivant à la même distance. L'écart entre
les deux calques reste réel (sinon plus aucun relief), mais nettement plus
modeste — le cadre de découpe déjà en place porte l'essentiel de la
sensation de profondeur, plus besoin d'un grand écart brut pour ça.

## Parallaxe : un contour d'ombre pour ancrer visuellement l'effet

Retour précis après un second essai : le personnage flottait bien au-dessus
du fond (le cadre les contient désormais correctement), mais sans vraiment
sembler "incrusté" dedans — juste deux images empilées, sans profondeur
perçue. Correctif classique pour ce type d'effet (photo 3D, diorama) : un
**contour d'ombre** — un dégradé sombre sur les bords du cadre, transparent
au centre — ajouté comme calque le plus proche de la caméra, devant le
personnage. Ça donne l'impression de regarder dans un coffret en creux
plutôt qu'un simple empilement plat.

Généré une seule fois (un dégradé radial sur un petit canvas, réutilisé pour
toutes les cartes, aucun coût par carte), et découpé par le même cadre que
les autres calques pour ne jamais déborder.

## Ouverture de booster : seule la 1ère carte est cachée, texte non-sélectionnable, parallaxe renforcé

Trois correctifs après retour d'usage :

- **Rythme de révélation changé** : seule la toute première carte se présente
  face cachée et demande un clic dédié pour la retourner. Les cartes
  suivantes arrivent directement face visible — un seul clic fait défiler
  chacune d'elles, au lieu de deux (retourner, puis passer).
- **Texte de l'écran de révélation non-sélectionnable** : le même correctif
  déjà appliqué au plateau de combat et à l'écran de victoire/défaite
  manquait sur cet écran précis — un appui un peu long en cliquant sur la
  carte sélectionnait le texte par accident.
- **Effet parallaxe très nettement renforcé** : l'écart de profondeur entre
  les deux calques (fond, personnage) était de 0,09 unité pour une caméra
  placée à 7 unités et une carte large de 2,2 — beaucoup trop faible pour
  produire un effet perceptible, ce qui expliquait le retour "l'effet est
  nul". Porté à 0,50 unité (environ 5,5 fois plus), le personnage se
  détache maintenant nettement en avant de la carte pendant la rotation.

## Bug réel : deux decks au même contenu s'affichaient tous les deux comme actifs

Reproduit concrètement : dupliquer un deck (ou en sauvegarder deux avec la
même composition) affichait **les deux comme actifs simultanément**. La
cause : le deck actif était déterminé en comparant le *contenu* des cartes
plutôt que l'*identité* du deck choisi — une ambiguïté de conception, pas un
accident isolé.

**Corrigé en profondeur** : le serveur suit maintenant un `activeDeckId`
explicite plutôt que de deviner par comparaison de contenu. Modifier le deck
actuellement actif met à jour le deck en jeu ; le supprimer retire proprement
le lien sans casser le deck en jeu ; une sauvegarde rapide hors deck nommé
clarifie qu'elle ne correspond plus à un deck précis. Voir
`test-deck-active-bug.js`.

## Grand écran de victoire/défaite : récompenses, rang, non-sélectionnable

Le texte "VICTOIRE"/"DÉFAITE" n'est plus sélectionnable à la souris (même
correctif que pour le plateau de combat). Un bouton "Quitter" dédié apparaît
en dessous, pour les deux issues — le fond de l'écran n'est plus cliquable
pour fermer, seul ce bouton le fait. L'écran affiche aussi les récompenses
(points de classement, boosters bonus, récompense de boss) et le
**changement de rang** quand il y en a un, calculé en comparant le rang
juste avant le rafraîchissement du profil à celui juste après.

## Vérification totale du projet

Passage complet : audit de syntaxe sur tous les fichiers serveur et client,
vérification de toutes les références HTML/JS, et exécution de la totalité
des 58 fichiers de test — plusieurs fois de suite pour les tests basés sur
un tirage aléatoire, où une seule exécution ne suffit pas à garantir la
stabilité.

Deux vrais bugs trouvés à cette occasion, tous les deux dans des fichiers de
**test**, pas dans l'application :

- `test-pack-reveal.js` s'était cassé après l'ajout d'une méthode entre les
  deux repères de texte qu'il utilisait pour découper le code à tester —
  fragilité de découpe, pas un bug applicatif.
- `test-blackjack-engine.js` supposait à plusieurs endroits qu'une manche
  fraîchement distribuée serait toujours "en cours", sans jamais tenir
  compte du blackjack naturel à la donne (~4,8% de chance) qui termine la
  manche immédiatement — provoquant un échec intermittent (15 à 20% des
  lancers). Corrigé avec un utilitaire qui redonne jusqu'à obtenir une main
  non-naturelle pour les étapes qui en ont besoin, rendant le test
  déterministe sans rien retirer à ce qu'il vérifie.
- `test-mulligan.js` supposait qu'une carte tout juste remplacée ne pouvait
  jamais revenir dans la main — sans tenir compte du fait que le mulligan
  recycle les cartes échangées dans la pioche avant de la mélanger, ce qui
  peut légitimement la faire repiocher par hasard. Assertion retirée (elle
  ne vérifiait rien de fiable), les vérifications de taille de main/pioche
  restent.
- `test-deck-limits.js` supposait qu'un compte de départ possède une carte
  légendaire, alors que le deck de départ en est *volontairement* dépourvu
  par conception. Corrigé, avec l'ajout d'une route admin générique
  (`grant-card`) pour offrir une carte précise — utile aussi en dehors des
  tests.

## Bouclier de Provocation (façon ornement)

Un serviteur avec Provocation affiche maintenant un anneau métallique bleuté
autour de son portrait circulaire, avec un insigne bouclier **centré derrière
le rond** (bien plus grand que le portrait, pour dépasser visiblement tout
autour) — le même langage visuel que les ornements de héros — plutôt que le
petit badge texte "PROV" d'avant, moins lisible en un coup d'œil.

**Un vrai piège de structure trouvé au premier essai** : le bouclier était
d'abord posé À L'INTÉRIEUR de `.minion-portrait`, qui a `overflow:hidden`
pour garder l'image bien circulaire — tout ce qui dépasse du cercle y est
automatiquement rogné, y compris un bouclier censé dépasser derrière. Corrigé
en sortant l'anneau et le bouclier dans une enveloppe de positionnement
séparée, sans découpe, qui entoure le portrait sans le remplacer.

## Image de booster affichée partout, et déchirure remplacée par un zoom + fondu

Trois vrais trous trouvés à l'usage (l'image de booster n'était en réalité
câblée que dans l'animation d'ouverture, nulle part ailleurs) :

1. **La route `/api/shop` ne renvoyait même pas `packImage`** dans sa
   réponse — impossible pour le client de l'afficher, même correctement
   uploadée et stockée.
2. **La vignette de la boutique lisait le mauvais champ** (`backImage`, le
   dos de carte, au lieu de `packImage`, l'image du paquet).
3. **L'inventaire n'affichait qu'une icône 🎁 générique**, sans jamais
   consulter l'image réglée pour l'extension du booster concerné.

Les trois sont corrigés : boutique, booster gratuit (état fermé, avant même
de cliquer) et inventaire affichent maintenant tous la vraie image de
booster quand l'admin en a réglé une, avec repli sur l'apparence générique
d'origine sinon.

**L'animation d'ouverture** est passée d'une déchirure en deux moitiés à un
**zoom + fondu** plus simple : le paquet grandit légèrement puis s'efface,
sans notion de "haut" ou "bas" à gérer — plus direct, et qui s'adapte à
n'importe quelle forme d'image sans découpage.

## Achat groupé de boosters, enchaînement d'ouverture, et plateau qui tient sans molette

- **Boutique** : un sélecteur de quantité (1 à 20) à côté de chaque booster —
  le prix total est débité en une seule fois, refusé en bloc si les fonds
  manquent (aucun achat partiel possible).
- **Inventaire** : à la fin de l'ouverture d'un booster, un bouton "Ouvrir le
  suivant" apparaît s'il en reste en réserve, pour enchaîner sans repasser
  par l'onglet Boosters.
- **Plateau de combat** : ajusté automatiquement à la hauteur de la fenêtre
  après chaque rendu (mesure réelle du contenu, jamais une taille fixe
  devinée à l'avance) — plus besoin de défiler avec la molette, quelle que
  soit la taille de la main ou de l'écran. L'échelle ne descend jamais sous
  60% pour rester lisible.

**Deux vrais bugs de test trouvés en vérifiant, pas des bugs d'application**
: mes propres suites de test supposaient que `/api/shop/buy-booster`
renvoyait un objet `stored` unique — un changement nécessaire pour l'achat
groupé (qui renvoie maintenant un tableau) les a cassées. Et un test sur les
fonds insuffisants échouait parce qu'il oubliait qu'un nouveau compte démarre
avec 100 crédits, pas 0. Les deux corrigés, pas l'application.

## Image de booster par extension

Chaque extension peut avoir sa propre image de paquet (Admin → Extensions),
utilisée pendant la secousse et la déchirure à l'ouverture — l'image de
"L'édition de Base" est utilisée pour le booster gratuit ; un booster acheté
en boutique et ouvert depuis l'inventaire affiche l'image de SA propre
extension. Sans image réglée, repli automatique sur la boîte générique
d'origine, sans rien casser.

Pendant la déchirure, les deux moitiés affichent chacune leur portion de la
MÊME image (positionnement haut/bas sur une image doublée en hauteur) plutôt
qu'un dégradé uni, pour que la séparation reste visuellement continue —
comme un vrai paquet qu'on ouvre en deux, pas deux blocs de couleur
indépendants.

**Vérifié avant d'ajouter le CSS** : le conteneur de l'animation d'ouverture
vit dans un conteneur flex (`.pack-stage`), le même type de parent que celui
qui avait causé l'effondrement de la main en éventail plus tôt — cette fois
avec une largeur explicite fixée (pas de `width:auto` dépendant du contenu),
donc le même piège ne s'applique pas ici. Vérifié en le raisonnant avant de
livrer, pas après un nouveau bug.

**Mise à jour** : l'animation de déchirure a depuis été remplacée par un
zoom + fondu (voir plus bas) — le paquet grandit et s'efface plutôt que de
se déchirer en deux.

## Main en éventail (façon vrai jeu de cartes)

En m'appuyant sur ta spécification, la main en combat n'est plus une simple
rangée : c'est un **véritable éventail**, calculé carte par carte selon sa
distance au centre — la carte centrale est presque verticale et la plus
haute, les cartes extérieures s'inclinent progressivement et descendent
légèrement, comme un jeu de cartes tenu en main. La carte survolée se
redresse, grossit et passe devant les autres, sans perdre sa position
horizontale dans l'éventail (elle se soulève sur place, elle ne saute pas au
centre).

Les cibles valides en mode ciblage (attaque ou sort) pulsent maintenant
doucement, pour rendre le mode ciblage plus lisible d'un coup d'œil.

**Limite assumée** : je n'ai pas ajouté de ligne/flèche reliant visuellement
l'attaquant à sa cible pendant le ciblage (comme décrit dans la
spécification) — l'architecture actuelle reconstruit tout le DOM à chaque
mise à jour, ce qui rend un tracé SVG suivant le curseur en temps réel
nettement plus complexe à faire proprement que le reste de ces
améliorations. Le glow pulsé sur les cibles remplit un rôle similaire
(rendre le mode ciblage évident) avec un risque bien moindre.

**Un point de la spécification déjà satisfait sans rien changer** : la
séparation stricte entre la logique de jeu et les animations, que la
spécification présente comme une règle de développement critique, est déjà
la façon dont ce projet fonctionne depuis le début — le serveur calcule
l'état réel du combat, et le client ne fait que comparer l'état précédent au
nouveau pour décider quoi animer, sans jamais influencer les règles.

## Inventaire de boosters

Un booster acheté en boutique n'est plus ouvert immédiatement : il est rangé
dans **ton inventaire** (onglet Boosters), visible avec le nom de son
extension. Ouvre-le quand tu veux, un par un, avec le bouton "Ouvrir" — la
même mise en scène (secousse, déchirure, révélation carte par carte) que le
booster gratuit s'applique.

## Ouverture de booster : déchirure du paquet

Nouvelle étape entre la secousse et la révélation : le paquet se sépare en
deux moitiés qui pivotent comme un vrai emballage qu'on déchire par le haut,
avec un flash de lumière. Les deux points d'entrée (booster gratuit et
booster d'inventaire) partagent exactement la même séquence.

## Vitrine de succès (profil)

Depuis l'onglet Succès, sélectionne jusqu'à **5 succès débloqués** à mettre
en avant sur ton profil — les autres joueurs les voient (nom + icône) quand
ils consultent ta fiche depuis l'onglet Joueurs.

## Casino : machine à sous et blackjack en double monnaie

Le casino accepte maintenant **crédits ET poussière**, avec un coût
indépendant réglable pour chacun (0 = cette monnaie n'est pas proposée). La
machine à sous a été refaite visuellement : cadre doré, fronton, et un vrai
effet de rouleaux qui tournent (cycle de symboles aléatoires pendant que la
requête est en vol, puis atterrissage avec rebond).

**Nouveau : Blackjack (21)** contre le croupier, mise en crédits et/ou
poussière (réglable indépendamment, comme le casino). Règles standards : les
As comptent 11 ou 1 selon ce qui évite un dépassement, le croupier tire
jusqu'à 17 minimum, un blackjack naturel (as + figure à la donne) paie 3
pour 2. Une seule manche à la fois par joueur.

**Un vrai bug trouvé en testant** : après avoir ajouté le blackjack au
modèle de données des événements, la fonction serveur qui applique les
modifications de l'admin ne savait pas encore quoi faire du champ
`blackjack` — toute tentative de configuration depuis le panel admin était
silencieusement ignorée. Corrigé.

**Un autre gap trouvé en même temps** : en passant le casino en double
monnaie, j'avais mis à jour le serveur mais oublié de mettre à jour le
formulaire admin correspondant — le champ de coût affichait une valeur
obsolète et ne pouvait plus rien enregistrer. Corrigé aussi, avec les deux
champs (poussière et crédits) désormais bien séparés dans le formulaire.

## Packs de crédits (poussière → crédits)

Nouvelle section dans la Boutique : des "packs" convertissant de la
poussière en crédits, dont l'admin fixe librement le nombre de crédits et le
prix en poussière pour chacun.

## Système de succès déblocables

Nouvel onglet **Succès**, visible pour tous les joueurs. L'admin crée des
succès depuis **Admin → Succès**, chacun basé sur un seul type de condition
choisi parmi un catalogue de 11 métriques liées au jeu, aux événements et à
l'économie :

- Jouer des cartes d'un type donné (serviteur / arme / sort) X fois
- Jouer une carte précise X fois
- Battre un adversaire précis X fois
- Finir 1er du classement mensuel (X fois)
- Atteindre un rang (un rang supérieur compte aussi)
- Compléter une collection (une extension précise, ou la totalité du pool)
- Dépenser des crédits ou de la poussière (montant cumulé)
- Gagner des combats classés (total)
- Vaincre le boss d'événement (total)
- Décrocher un jackpot au casino (total)

Chaque succès a sa propre icône (uploadable), sa description, et une
récompense en crédits et/ou poussière créditée **immédiatement** au
déblocage. Le formulaire de création s'adapte automatiquement au type de
condition choisi (liste des cartes, des joueurs, des rangs, des extensions
selon le cas).

Les joueurs voient leur progression (barre de 0 à 100%) sur chaque succès non
débloqué, et reçoivent une **notification en temps réel** dès qu'un succès se
débloque — pendant un combat (via socket) comme après un achat, un échange ou
un tour de casino (via la réponse de l'action elle-même). Plusieurs
déblocages simultanés s'affichent l'un après l'autre, jamais empilés ni
perdus.

**Un vrai bug trouvé, mais dans mon test, pas dans l'application** : la
suppression d'un succès semblait échouer en testant — la cause était que
mon test avait oublié d'envoyer le code admin dans le corps de la requête
DELETE. Corrigé côté test ; la route elle-même fonctionnait déjà
correctement.

## Programmation par dates et personnalisation avancée du boss


Le casino et le boss ont chacun leur propre **période d'activation**
optionnelle (date de début / date de fin) réglable dans un calendrier côté
admin — les deux se combinent avec l'interrupteur manuel (il faut les deux
pour qu'un mini-jeu soit réellement actif). Sans dates, seul l'interrupteur
compte, comme avant. Les joueurs voient un décompte "⏳ X jour(s) restant(s)"
sur la carte de l'événement concerné quand une date de fin est configurée.

Le boss se personnalise plus en profondeur :

- **Deck sur mesure** — l'admin choisit précisément les cartes du boss
  (minimum 4) au lieu d'un tirage aléatoire dans tout le pool. Un deck vide
  revient au comportement aléatoire par défaut.
- **Son d'entrée** — joué au lancement du combat.
- **Dialogue / lore à seuils de PV** — l'admin ajoute des répliques
  déclenchées automatiquement quand les PV du boss passent sous un seuil
  donné (ex : une réplique à 100%, une autre à 50%, une dernière à 0%),
  affichées en bulle au-dessus de son portrait, une seule fois par seuil et
  par combat. Chaque réplique a sa propre case à cocher : la désactiver la
  garde en mémoire (pas besoin de la retaper) sans qu'elle se déclenche en
  combat.

**Un vrai bug de logique trouvé en écrivant le test** : ma première version
choisissait le premier seuil "trivialement" satisfait plutôt que le plus
proche des PV actuels — un boss tombé directement à 45% aurait affiché sa
réplique d'entrée (100%) au lieu de celle à 50%. Corrigé en parcourant les
seuils du plus bas au plus haut.

**Limite assumée** : si un coup unique fait sauter un boss par-dessus
plusieurs seuils d'un coup (ex : de 100% à 5%, sautant le seuil 50%), seul le
seuil le plus proche des PV actuels se déclenche — les répliques
intermédiaires "sautées" ne s'affichent pas rétroactivement. Comportement
volontaire plutôt qu'un vrai bug : afficher toutes les répliques manquées
d'un coup aurait été plus perturbant qu'utile.

## Contenu personnalisable (Admin → Contenu)

L'admin peut désormais modifier une bonne partie des textes, icônes, images
et sons de l'application sans toucher au code, depuis un nouvel onglet
**Admin → Contenu** :

- **Textes** : libellés du menu latéral, titres et sous-titres de page,
  quelques textes de combat (bouton de fin de tour, écran de mulligan), les
  noms des trois types de carte (Serviteur/Arme/Sort), quelques boutons
  courants (déconnexion, ajouter en ami, défier), les mots "crédits" et
  "poussière", des messages d'état vide, le nom et le sous-titre de l'écran
  de connexion. Une quarantaine d'entrées au total, groupées par thème.
- **Icônes** : les émojis/symboles du menu latéral, des monnaies (crédits,
  poussière) et du bouton de visionneuse 3D.
- **Logo** : remplace celui utilisé dans la sidebar et l'écran de connexion.
- **Sons de jeu** : chacun des 7 sons synthétisés (impact d'attaque,
  ouverture de booster, révélation de carte, début de tour, victoire,
  défaite, pose de carte par défaut) peut être remplacé par un vrai fichier
  audio uploadé — avec un bouton pour revenir au son synthétisé par défaut.

Un champ laissé tel quel garde sa valeur d'origine (fusion, jamais un
remplacement complet du registre) ; une chaîne vide n'écrase jamais un texte
existant, pour éviter de casser un libellé par erreur.

**Limite assumée** : ceci couvre les textes/icônes les plus visibles, pas
*littéralement* chaque chaîne du fichier (il y en a des milliers, et les
couvrir toutes aurait représenté un risque de régression disproportionné
pour un gain marginal sur des textes rarement vus). Le système est conçu
pour être facile à étendre : ajouter une clé dans `src/content.js` puis
un `t('ma.clé', 'Texte par défaut')` au bon endroit dans `app.js` suffit.

## Animation d'attaque : recul puis charge

L'animation d'attaque a été retravaillée pour se rapprocher de Hearthstone :
avant de frapper, l'attaquant (serviteur ou héros armé) **recule légèrement**
comme pour prendre son élan, puis **charge** vers sa cible et s'y tient un
instant avant de revenir à sa place — plutôt qu'un simple bond vers l'avant.
Le héros lui-même prend cette animation quand il attaque avec son arme
équipée. Respecte `prefers-reduced-motion` comme le reste des animations de
combat.

**Limite connue** : l'attaque qui brise une arme (durabilité tombant à 0,
l'arme disparaissant aussitôt) ne déclenche pas cette animation côté
attaquant — il n'y a plus d'arme à comparer une fois brisée pour détecter
qu'une attaque a eu lieu. La cible, elle, montre toujours normalement les
dégâts reçus. Cas rare, sans conséquence fonctionnelle.

## Effets sonores de jeu

En plus des sons personnalisés par carte (déjà existants, uploadés par
l'admin), l'application joue maintenant des **sons de jeu synthétisés** —
générés directement par le navigateur via l'API Web Audio, sans aucun
fichier à charger :

- **Impact d'attaque** — à chaque fois qu'une attaque touche sa cible (serviteur ou héros).
- **Ouverture de booster** — un souffle au moment où le paquet s'ouvre, puis
  un petit carillon à chaque carte révélée, dont le nombre de notes et la
  richesse augmentent avec la rareté (une légendaire sonne nettement plus
  riche qu'une commune).
- **Début de ton tour** — un carillon discret.
- **Victoire / défaite** — un motif ascendant ou descendant en fin de partie.
- **Pose de carte par défaut** — un petit son léger pour les cartes qui n'ont
  pas de son personnalisé assigné par l'admin (à la place du silence total
  d'avant).

Ces sons suivent le même interrupteur 🔊/🔇 que les sons de cartes.

## Cartes armes

Nouveau type de carte, aux côtés des serviteurs et des sorts : les **armes**.
Elles s'équipent au héros (visibles à côté de son portrait, comme dans
Hearthstone) et lui permettent d'attaquer directement — à la place ou en plus
de ses serviteurs.

- **Dégâts**, **durabilité** (nombre d'utilisations avant que l'arme se
  brise) et **utilisations par tour** sont personnalisables à la création
  (Admin → Cartes → type "Arme"). Une durabilité à 2 avec 1 utilisation/tour
  permet d'attaquer une fois par tour pendant deux tours ; une arme à 2
  utilisations/tour peut frapper deux fois le même tour.
- **Soin à l'équipement** disponible, comme le cri de guerre des serviteurs.
- Équiper une nouvelle arme **remplace l'ancienne** (pas d'empilement).
- Le héros armé respecte les mêmes règles que les serviteurs : **Provocation**
  obligatoire si l'adversaire en a une en jeu, riposte des serviteurs ciblés
  (qui tombe directement sur les PV du héros, sans armure).
- Le bot d'entraînement équipe et utilise lui aussi ses armes automatiquement.

En combat, clique sur ton propre héros pour l'attaquer avec son arme équipée
(si elle a encore des utilisations ce tour-ci) — sinon le clic ouvre la roue
de provocations comme d'habitude. Le petit bouton 💬 reste disponible pour
émoter même quand une arme est prête à attaquer.

## Comptes vierges à la création

Un nouveau compte démarre désormais **sans deck ni carte** — tout s'obtient en
jouant (boosters gratuits, boosters achetés en boutique, ou échanges). Si un
joueur est bloqué sans savoir comment démarrer, l'admin peut lui offrir un
deck de départ complet (30 cartes prêtes à jouer) depuis **Admin → Comptes**,
bouton "Offrir un deck de départ" — ça ajoute les cartes à sa collection sans
jamais lui retirer ce qu'il possède déjà.

## Decks nommés (bibliothèque de decks)

Onglet **Deck** → section "Mes decks" : enregistre plusieurs decks sous des
noms différents (jusqu'à 12), passe de l'un à l'autre en un clic ("Activer"),
renomme-les ou supprime-les. Activer un deck **revalide sa composition** au
moment même — si tu as désenchanté ou échangé des cartes depuis
l'enregistrement, un deck devenu invalide est refusé avec une explication
claire plutôt que d'être activé silencieusement cassé.

## Désenchantement (anciennement "Poussière")

L'onglet a été renommé pour être plus explicite sur ce qu'il fait
(transformer les doublons en poussière). La poussière elle-même garde son nom
partout ailleurs (boutique, icône ✧, récompenses).

## Correction : le focus des champs de recherche

Bug corrigé : taper dans un champ de recherche (joueurs, comptes admin...)
faisait perdre le focus à chaque lettre, obligeant à recliquer sans arrêt.
Le rendu de l'interface reconstruit tous les éléments à chaque mise à jour
(y compris les champs de saisie) ; le focus et la position du curseur sont
maintenant explicitement restaurés après coup sur le nouvel élément, pour
n'importe quel champ texte de l'application.

## Échanges : plusieurs cartes, jamais à sens unique

Refonte du système d'échange :

- **Donner ou recevoir sans contrepartie est autorisé** — une proposition peut
  ne contenir des cartes que d'un seul côté (un cadeau, ou une demande sans
  rien offrir en retour). Seule une proposition totalement vide (rien des
  deux côtés) est refusée.
- **Plusieurs cartes possibles de chaque côté** en une seule proposition
  (jusqu'à 10 par camp).
- Nouvelle interface : depuis la fiche d'un joueur, bouton "Proposer un
  échange" ouvre un vrai constructeur — clique sur ses cartes pour les
  demander, sur les tiennes pour les offrir, envoie quand les deux côtés
  contiennent au moins une carte.
- La vérification de possession se fait toujours à l'acceptation (pas à la
  création) : si une carte n'est plus disponible entretemps, l'échange est
  invalidé proprement, sans rien dupliquer ni perdre.

## Booster bonus en fin de match

Gagner un combat (PvP uniquement, jamais contre le bot) donne une petite
chance de recevoir un booster bonus gratuit — **0,5% par défaut**, réglable.

- **Admin → Extensions** : un réglage global fixe la probabilité (0 à 100%),
  et chaque extension a une case "Éligible au booster bonus de fin de match"
  — seules les extensions cochées peuvent sortir en bonus.
- Le booster tiré suit les mêmes règles de rareté que d'habitude (taux par
  défaut ou taux de drop personnalisé par carte).
- Une bannière dorée annonce le bonus juste après la victoire, avec le nom
  de l'extension et les 5 cartes obtenues.

## Extensions et boosters de la boutique

Une **extension** regroupe des cartes et son propre dos de carte, comme un
set dans un vrai jeu de cartes. Le jeu démarre avec une extension **Édition
de Base** contenant toutes les cartes de départ ; l'admin peut en créer
d'autres depuis **Admin → Extensions**.

- **Créer une extension** — nom, description, dos de carte (image), et deux
  prix de booster indépendants : un en crédits, un en poussière. Laisser un
  prix vide = ce booster ne se vend pas dans cette monnaie.
- **Assigner une carte à une extension** — se choisit dans le formulaire de
  création/édition de carte (Admin → Cartes).
- **Acheter un booster** — Boutique → onglet **Boosters** : chaque extension
  active y apparaît avec ses prix. Le tirage des 5 cartes est limité aux
  cartes de cette extension (mêmes règles de rareté et de taux de drop
  personnalisé que d'habitude).
- **L'extension de base est protégée** — impossible à supprimer. Les autres
  extensions ne peuvent être supprimées que si elles ne contiennent plus
  aucune carte (réaffecte ou supprime les cartes d'abord).

Le booster gratuit toutes les 10 minutes (onglet Boosters) reste indépendant
de ce système : il pioche toujours dans **l'ensemble du pool**, toutes
extensions confondues. Les boosters achetés en boutique sont un moyen
supplémentaire d'obtenir des cartes, extension par extension.

## Modifier une carte existante

Bouton **✏️ Modifier** sur n'importe quelle carte du pool (Admin → Cartes) :
le formulaire du haut se prérempli avec ses valeurs actuelles (nom, rareté,
coût, statistiques, effet, extension...). Le type (serviteur/sort) ne se
change pas après création — supprime et recrée la carte si besoin.
L'image, le son et le taux de drop se modifient séparément, directement
depuis la vignette de la carte dans la grille.

## Combat de test contre un bot

Bouton **« Lancer un combat de test »** en haut de l'onglet Admin → Cartes.
Un bot d'entraînement affronte l'admin avec deux decks de 30 cartes tirés
aléatoirement dans **tout le pool actuel** — pratique pour voir en jeu une
carte qu'on vient de créer, sans avoir à construire un deck dédié.

- L'IA du bot est volontairement simple : elle joue ses serviteurs les plus
  chers en premier, utilise ses sorts avec quelques règles de bon sens (se
  soigne si son héros est bas, renforce son meilleur serviteur, vise le
  serviteur ennemi le plus faible si ça peut le tuer), puis attaque
  directement le héros adverse (ou une Provocation si présente).
- **Ne compte jamais pour le classement ni la poussière** — sans cette
  protection, on pourrait en abuser pour farmer des points contre un
  adversaire trop prévisible.

## Provocations (emotes)

Pendant un combat, **clique sur ton propre avatar** pour ouvrir ta roue de
provocations. Choisis-en une : elle s'affiche instantanément en bulle chez toi
**et chez ton adversaire**, puis disparaît au bout de 3,5 secondes.

- **6 emplacements** dans la roue, configurables depuis ton profil (onglet
  Collection, section « Ma roue de provocations »).
- **6 provocations gratuites** dès l'inscription (« Salut ! », « Bien joué ! »,
  « GG ! »…).
- **12 provocations achetables** en poussière dans la boutique, onglet
  Provocations : « ez » (80 ✧), « C'est tout ce que tu peux faire ? » (120 ✧),
  « Tu dors ? » (140 ✧), « Une légende est née. » (300 ✧)…
- **Anti-spam** : 3 secondes minimum entre deux provocations. Le serveur vérifie
  aussi que la provocation envoyée appartient bien à ta roue, donc un client
  modifié ne peut pas envoyer n'importe quoi.

### Créer des provocations depuis l'admin

L'onglet **Admin** permet d'ajouter des provocations à la boutique sans toucher
au code : texte (60 caractères max), prix en poussière et ton (neutre, amical,
piquant, fier).

- **Prix 0** → la provocation est offerte immédiatement à tous les joueurs,
  y compris ceux déjà inscrits.
- **Prix > 0** → elle apparaît en boutique et doit être achetée.
- **Modifier le prix** → chaque provocation de la grille admin a un champ de
  prix et un bouton « Fixer ». Le nouveau tarif s'applique aussitôt en boutique.
  Passer un prix à **0** l'offre à tous les joueurs ; repasser une gratuite en
  payante ne la retire pas à ceux qui la possèdent déjà.
- **Suppression** → la provocation est retirée de la boutique, des collections
  et des roues des joueurs, dont les roues sont automatiquement recomplétées
  à 6 emplacements.

Les provocations sont stockées dans `data/emotes.json` (initialisé depuis
`SEED_EMOTES` dans `src/cards.js` au premier lancement).



## Gestion des comptes (Admin)

L'onglet **Admin → Comptes** liste tous les joueurs inscrits, avec recherche.
Pour chacun :

- **Voir la collection** — consultation en lecture seule.
- **Réinitialiser le mot de passe** — utile si un joueur a oublié le sien ;
  demande un nouveau mot de passe (4 caractères minimum), aucune confirmation
  de l'ancien n'est requise (c'est bien le rôle de l'admin).
- **Ajuster la poussière ou les crédits** — deux champs ± indépendants, jamais en dessous de 0.
- **Supprimer le compte** — irréversible, demande de retaper exactement le
  pseudo pour confirmer. Le compte est aussi retiré des listes d'amis des
  autres joueurs.

## Sons de cartes

Une carte peut avoir un **son joué au moment où elle est posée sur le champ de
bataille**. Les **deux joueurs l'entendent** simultanément, avec le nom de la
carte affiché sous le plateau.

Depuis l'onglet **Admin** :

- **À la création** d'une carte, un champ « Son joué à la pose » à côté du champ
  image (MP3, WAV, OGG, M4A ou AAC — **2 Mo max**, garde des sons courts).
- **Sur une carte existante**, la grille du pool propose « Ajouter un son » /
  « Remplacer le son », avec un bouton **▶ Écouter** pour vérifier avant de
  valider, et **Retirer** pour repasser la carte en silencieux.
- Les cartes sonores portent un petit badge 🔊 dans toutes les vues.

Côté joueur, un bouton **🔊 Sons activés / 🔇 Sons coupés** est disponible sous
le plateau pendant le combat. Le réglage vaut pour la session en cours.

Les fichiers sont stockés dans `public/uploads/sounds/`.

### Comment la lecture fonctionne

Le son passe par l'**API Web Audio** (`public/audio.js`) et non par des éléments
`<audio>` : chaque fichier est téléchargé et décodé **une seule fois**, puis
rejoué à volonté. C'est ce qui garantit qu'une carte posée plusieurs fois dans
la même partie sonne **à chaque fois** — un élément `<audio>` réutilisé reste
bloqué sur sa fin de lecture et ne se déclenche qu'une fois.

Les sons du pool sont préchargés au démarrage et après chaque modification en
admin, donc pas de latence à la première pose. Deux sons rapprochés se
superposent au lieu de se couper.

Les navigateurs démarrent l'audio « suspendu » tant que l'utilisateur n'a pas
interagi avec la page : le contexte est réveillé au premier clic ou appui
clavier. Si l'API Web Audio est indisponible, un repli crée un élément audio
neuf à chaque lecture. Dans tous les cas, un échec de lecture n'interrompt pas
la partie et le nom de la carte reste affiché.

## Rangs et classement

Chaque victoire rapporte un nombre **aléatoire de points entre +10 et +29**.

| Rang | Points requis |
|---|---|
| Bronze | 0 |
| Argent | 300 |
| Or | 800 |
| Diamant | 1 600 |
| Maître | 3 000 |

Le classement est **remis à zéro chaque mois**. Au premier lancement du serveur
après un changement de mois, le podium est récompensé automatiquement :
**1er → 500 ✧, 2e → 250 ✧, 3e → 100 ✧**. Les compteurs de saison repartent à zéro
et les victoires sont archivées en total à vie. Le podium est consultable dans
l'onglet Classement.

## Règles de combat

- Deck de 30 cartes, 4 cartes en main au départ, 30 PV par héros.
- 1 mana au tour 1, +1 par tour jusqu'à 10.
- **Serviteurs** : attaque + points de vie. Ils ne peuvent pas attaquer le tour
  de leur invocation, sauf s'ils ont **Charge**.
- **Provocation** : tant qu'un serviteur avec Provocation est en jeu en face,
  il faut l'attaquer avant de viser le héros ou les autres serviteurs.
- **Sorts** : dégâts ciblés, soin ciblé (héros ou serviteur ami), bonus
  d'attaque, dégâts de zone, soin de zone.
- **Cri de guerre** : certains serviteurs soignent en arrivant.
- Plateau limité à 7 serviteurs, main à 10 cartes, fatigue quand la pioche est vide.

Un sort lancé sur une cible invalide **ne consomme ni mana ni carte** — la
sélection est simplement annulée.

## Images de cartes

Dans l'onglet Admin, chaque carte créée peut recevoir une image (PNG, JPG, WEBP
ou GIF, 3 Mo max) et un son (voir plus bas). On peut aussi remplacer l'image d'une carte existante depuis
la grille du pool. Les fichiers sont stockés dans `public/uploads/cards/`, les
avatars dans `public/uploads/avatars/`.

Les cartes sans image affichent une icône de repli, donc rien ne casse si tu
n'en mets pas partout.

## Effets visuels par rareté

- **Commun** : sobre.
- **Rare** : léger liseré bleu.
- **Épique** : halo violet, inclinaison 3D au survol, reflet lent.
- **Légendaire** : cadre doré, inclinaison 3D plus marquée, reflet doré qui
  balaye la carte en continu.

Ces effets respectent `prefers-reduced-motion` : les animations se coupent
automatiquement pour qui a désactivé les animations dans son système.

## Architecture

```
server.js               → API REST + Socket.io + uploads (multer)
src/cards.js            → cartes de base, économie, rangs, ornements, poids de drop
src/game.js             → moteur de combat (Provocation, Charge, armure, sorts)
src/bot.js               → IA du combat de test contre le bot
src/ranking.js          → classement mensuel et clôture de saison
src/matchmaking.js      → file d'attente, défis entre amis, parties en cours
src/db.js / store.js    → persistance en fichiers JSON
src/auth.js             → bcrypt + sessions
public/                 → client web (index.html, app.js, audio.js, card3d.js, styles.css)
public/branding/logo.png → logo Clean Gang Decks (sidebar, écran de connexion, dos de carte par défaut)
data/                   → users.json, cards.json, emotes.json, extensions.json, ornaments.json, trades.json, meta.json, settings.json, content.json, events.json, achievements.json
test-engine.js          → 12 vérifications du moteur
test-season.js          → clôture de saison et récompenses
test-admin-emotes.js    → gestion des provocations depuis l'admin
test-emote-price.js     → modification des prix depuis l'admin
test-card-sound.js      → upload et diffusion des sons de cartes
test-audio.js           → relecture répétée d'un même son (côté client)
test-card3d.js          → cycle de vie des cartes 3D, fuite mémoire GPU (faux Three.js)
test-armor-effects.js   → armure et nouveaux effets de sort
test-admin-users.js     → gestion des comptes depuis l'admin
test-admin-drop-armor.js → taux de drop personnalisé et armure depuis l'admin
test-extensions-bot.js  → extensions, achat de booster, édition de carte, combat contre le bot
test-shop-booster-flow.js → achat de booster depuis la boutique de bout en bout
test-codex.js           → suivi cumulatif du codex (désenchantement, échanges)
test-custom-ornaments.js → ornements personnalisés (PNG) créés par l'admin
test-combat-anim.js     → logique de diff qui pilote les animations de combat
test-card-drag.js       → seuil clic/glisser et détection de la zone de dépôt
test-mulligan.js        → logique de choix de la main de départ
test-focus-preserve.js  → préservation du focus/curseur des champs à travers les re-rendus
test-trades.js          → échanges multi-cartes, obligation des deux côtés
test-saved-decks.js     → bibliothèque de decks nommés (enregistrer, activer, renommer, supprimer)
test-match-drop.js      → booster bonus de fin de match (probabilité, éligibilité, jamais contre le bot)
test-weapons.js         → mécanique des armes (moteur direct)
test-weapons-live.js    → armes en combat réel via sockets (manuel, deux phases — voir ci-dessous)
test-sfx.js             → construction du graphe audio des sons de jeu synthétisés
test-content.js         → registre de contenu personnalisable côté serveur (textes, icônes, médias, sons)
test-content-client.js  → fonctions client t()/icon()/playGameSound() (repli, remplacement, priorité au son personnalisé)
test-rewards-persist.js → bug réel corrigé : une action tardive après la fin d'un match n'efface plus les récompenses
test-events.js          → casino (coût, gains, config admin) et combat de boss (PV custom, récompense, limite quotidienne, aucun impact sur le classement)
test-casino-dual-currency.js → casino en double monnaie (crédits/poussière indépendants) et packs de crédits
test-blackjack-engine.js     → moteur de blackjack en isolation (main, blackjack naturel, croupier, résolution)
test-blackjack-integration.js → intégration réelle du blackjack (mise, une manche à la fois, paiement)
test-booster-inventory.js    → achat de booster rangé en inventaire, ouverture différée
test-achievement-showcase.js → vitrine de succès (5 max, visible par les autres joueurs)
test-hand-fan.js             → disposition de la main en éventail (symétrie, inclinaison progressive, empilement)
test-dynamic-media.js        → génération de la feuille de style dynamique pour les images d'interface
test-interface-media.js      → upload et lecture des 5 emplacements d'image d'interface via l'API
test-pack-image.js           → upload de l'image de booster par extension (API)
test-pack-image-client.js    → résolution côté client de l'image de booster à afficher pendant l'ouverture
test-pack-image-everywhere.js → l'image de booster est bien exposée partout où elle doit s'afficher (boutique, inventaire)
test-taunt-shield.js          → anneau + bouclier de Provocation (conditionné à taunt, ancien badge texte retiré)
test-credit-packs-e2e.js      → packs de crédits câblés de bout en bout (admin → boutique → achat)
test-match-result-overlay.js  → grand écran de victoire/défaite (résultat relatif au joueur, transition unique, nettoyage, styles)
test-parallax-card.js         → modèle serveur de l'effet parallaxe (activation à 2 calques complets, upload individuel, filet de sécurité pour l'image fixe)
test-parallax-admin-flow.js   → réactivation du parallaxe sans re-upload (bug trouvé et corrigé avant livraison)
test-parallax-3d.js           → structure du Group Three.js (4 enfants, profondeurs croissantes, libération mémoire récursive)
test-deck-active-bug.js       → suivi du deck actif par identité (activeDeckId), pas par comparaison de contenu\ntest-pack-reveal.js (mis à jour) → seule la 1ère carte demande un retournement, les suivantes arrivent déjà visibles\ntest-parallax-clipping.js     → cadre de découpe du parallaxe (vrai three.js) : suit la rotation, ne touche jamais le corps de la carte
test-buy-multiple-boosters.js → achat groupé de boosters (prix total, plafonnement, refus en bloc si fonds insuffisants)
test-continue-opening.js      → bouton "ouvrir le suivant" conditionné à un inventaire non vide
test-combat-fit.js            → calcul de l'échelle d'ajustement du plateau de combat à la fenêtre
test-events-schedule.js → programmation par dates (période d'activation, décompte), deck et dialogues du boss
test-boss-custom.js     → deck personnalisé et son d'entrée du boss en combat réel
test-boss-dialogue.js   → déclenchement des répliques de lore selon les seuils de PV
test-achievements-engine.js      → moteur de succès en isolation (11 types de condition, déblocage, progression)
test-achievements-integration.js → intégration réelle (CRUD admin, déblocage en combat et via achats, notifications)
test-deck-limits.js     → limite de copies par deck (manuel, voir ci-dessous)
test-live.js            → parcours complet bout-en-bout
```


### Test manuel : limite de deck

`test-deck-limits.js` a besoin d'injecter des cartes dans un compte de test,
ce qui suppose d'arrêter puis relancer le serveur entre deux étapes — il ne
rentre donc pas dans le moule des autres scripts `npm run test:*` (qui
supposent tous un serveur déjà lancé en continu). Pour le lancer :

```bash
node server.js &            # ou npm start dans un autre terminal
node test-deck-limits.js register
# arrêter le serveur (Ctrl+C ou kill), relancer node server.js
node test-deck-limits.js test
```

La règle elle-même (2 exemplaires max, 1 pour les légendaires) est appliquée
en permanence par le serveur — ce test ne fait que la vérifier explicitement.


### Test manuel : armes en combat réel

`test-weapons-live.js` crée une carte arme puis doit l'injecter dans deux
comptes, ce qui suppose (comme `test-deck-limits.js`) un redémarrage du
serveur entre deux étapes :

```bash
node server.js &
node test-weapons-live.js phase1
# noter l'ID de carte affiché, arrêter le serveur, injecter l'arme dans
# data/users.json pour les deux comptes créés (voir le script pour le détail),
# relancer node server.js
node test-weapons-live.js phase2
```

`test-weapons.js` (dans `npm test`) couvre déjà la mécanique en profondeur
sans avoir besoin de ce détour — ce test manuel ne fait que confirmer que le
même comportement tient aussi en conditions réelles (vrais sockets).

## Limites à connaître

- **Sessions en mémoire** : redémarrer le serveur déconnecte tout le monde. Les
  comptes, cartes et classements restent sauvegardés, seule la connexion est
  perdue. Pour y remédier, brancher un store type `connect-sqlite3` sur
  `express-session`.
- **Parties en mémoire** : redémarrer pendant un combat l'interrompt.
- **Code admin en variable d'environnement** : change-le avant de partager le
  jeu (`ADMIN_CODE=monCode npm start`). Sans ça, n'importe quel joueur connaissant
  `admin123` peut créer des cartes.
- **Un seul processus** : la file d'attente et les défis ne fonctionnent pas si
  tu lances plusieurs instances derrière un load balancer.
- **Pas de modération des images** : tout joueur peut uploader n'importe quelle
  image en avatar. À surveiller si le jeu sort du cercle d'amis.
- **Jouer à distance** : `localhost` n'est visible que depuis ta machine. Pour
  jouer avec des amis ailleurs, il faut ouvrir un port sur ta box ou déployer
  sur un hébergeur (Render, Railway, Fly.io, un VPS...).

## Pistes pour la suite

- Mots-clés supplémentaires : Discrétion, Bouclier divin, Râle d'agonie
- Pouvoirs de héros et classes de deck
- Vraie base de données (SQLite) + déploiement en ligne
- Récompenses de fin de saison plus riches (cartes exclusives, dos de carte)

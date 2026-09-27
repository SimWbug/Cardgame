/* ============================================================
   CLEAN GANG DECKS — cartes en 3D (Three.js)

   Un seul renderer WebGL partagé, réutilisé pour :
     - la visionneuse 3D d'une carte (modale, accessible depuis n'importe
       quelle grille de cartes),
     - l'ouverture de booster (jusqu'à 5 cartes en 3D, retournées une à une).

   Pourquoi un seul renderer : chaque contexte WebGL est une ressource limitée
   du navigateur (une dizaine en simultané, grand maximum). Faire une carte 3D
   par vignette dans une grille de 50 cartes casserait cette limite. On garde
   donc UN SEUL canvas/contexte, qu'on déplace dans le DOM et dont on
   reconstruit la scène selon ce qu'on doit montrer.
   ============================================================ */
import * as THREE from 'three';

const CARD_W = 2.2, CARD_H = 3.1, CARD_T = 0.06;
  const TEX_W = 512, TEX_H = 716;

  let renderer = null, scene = null, camera = null;
  let container = null;
  let rafId = null;
  let clock = null;
  let meshes = []; // { mesh, autoRotate, targetRotY, dragging }
  let pointer = { down: false, id: null, lastX: 0, lastY: 0, activeMesh: null };
  let resizeObserver = null;

  function ensureRenderer() {
    if (renderer) return;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    } catch (e) {
      throw new Error('WebGL indisponible dans ce navigateur : les cartes 3D ne peuvent pas s\'afficher.');
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(35, 1, 0.1, 100);
    camera.position.set(0, 0, 7);
    clock = new THREE.Clock();

    scene.add(new THREE.AmbientLight(0xffffff, 0.55));
    const key = new THREE.DirectionalLight(0xffffff, 0.9);
    key.position.set(3, 4, 5);
    scene.add(key);
    const rim = new THREE.PointLight(0x7c5cff, 0.6, 20);
    rim.position.set(-4, 2, 3);
    scene.add(rim);

    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';
    renderer.domElement.style.touchAction = 'none';
    renderer.domElement.style.cursor = 'grab';

    renderer.domElement.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
  }

  function onPointerDown(e) {
    if (meshes.length === 0) return;
    pointer.down = true;
    pointer.id = e.pointerId;
    pointer.lastX = e.clientX;
    pointer.lastY = e.clientY;
    // On fait pivoter la carte la plus proche du centre (visionneuse simple) ou toutes (booster)
    renderer.domElement.style.cursor = 'grabbing';
  }
  function onPointerMove(e) {
    if (!pointer.down) return;
    const dx = e.clientX - pointer.lastX;
    const dy = e.clientY - pointer.lastY;
    pointer.lastX = e.clientX; pointer.lastY = e.clientY;
    meshes.forEach(m => {
      if (!m.locked) {
        m.mesh.rotation.y += dx * 0.01;
        m.mesh.rotation.x = Math.max(-0.6, Math.min(0.6, m.mesh.rotation.x + dy * 0.01));
        m.userRotated = true;
      }
    });
  }
  function onPointerUp() {
    pointer.down = false;
    if (renderer) renderer.domElement.style.cursor = 'grab';
  }

  function fitCameraToContainer() {
    if (!container || !renderer) return;
    const w = container.clientWidth || 300;
    const h = container.clientHeight || 400;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  function disposeMesh(obj) {
    if (!obj) return;
    // Une carte avec parallaxe est un Group (le corps de la carte + les
    // calques empilés devant), pas un Mesh unique : on descend récursivement
    // pour libérer géométrie/texture de chaque enfant, sinon les calques
    // fuient en mémoire GPU à chaque nouvelle carte affichée.
    if (obj.geometry) obj.geometry.dispose();
    if (obj.material) {
      (Array.isArray(obj.material) ? obj.material : [obj.material]).forEach(mat => {
        if (mat.map) mat.map.dispose();
        mat.dispose();
      });
    }
    if (obj.children && obj.children.length) obj.children.forEach(child => disposeMesh(child));
  }

  function clearScene() {
    meshes.forEach(m => { scene.remove(m.mesh); disposeMesh(m.mesh); });
    meshes = [];
  }

  // Jeton d'annulation : si l'utilisateur redemande une autre carte pendant
  // qu'une composition de texture async est encore en cours, l'appel devenu
  // obsolète ne doit PAS ajouter son maillage à la scène (sinon la carte
  // précédente reste affichée en fantôme, jamais nettoyée : fuite mémoire GPU).
  let requestToken = 0;

  function loop() {
    rafId = requestAnimationFrame(loop);
    const dt = clock.getDelta();
    meshes.forEach(m => {
      if (m.autoRotate && !pointer.down) m.mesh.rotation.y += dt * 0.35;
      if (m.flip) {
        m.flip.t = Math.min(1, m.flip.t + dt / m.flip.duration);
        const ease = 1 - Math.pow(1 - m.flip.t, 3);
        m.mesh.rotation.y = m.flip.from + (m.flip.to - m.flip.from) * ease;
        if (m.flip.t >= 1) { m.flip = null; }
      }
    });
    renderer.render(scene, camera);
  }

  /* ---------- Composition de la texture (canvas 2D -> texture Three.js) ---------- */
  const RARITY_COLORS = { commun: '#8a8f9c', rare: '#4fa3e3', epique: '#c46bff', legendaire: '#e8b13d' };
  const RARITY_LABELS = { commun: 'Commun', rare: 'Rare', epique: 'Épique', legendaire: 'Légendaire' };

  function wrapText(ctx, text, x, y, maxWidth, lineHeight) {
    const words = String(text || '').split(' ');
    let line = '';
    const lines = [];
    words.forEach(w => {
      const test = line ? line + ' ' + w : w;
      if (ctx.measureText(test).width > maxWidth && line) { lines.push(line); line = w; }
      else line = test;
    });
    if (line) lines.push(line);
    lines.forEach((l, i) => ctx.fillText(l, x, y + i * lineHeight));
    return lines.length;
  }

  function loadImage(url) {
    return new Promise(resolve => {
      if (!url) { resolve(null); return; }
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = url;
    });
  }

  async function composeFrontTexture(card, hideArt) {
    const canvas = document.createElement('canvas');
    canvas.width = TEX_W; canvas.height = TEX_H;
    const ctx = canvas.getContext('2d');
    const color = RARITY_COLORS[card.rarity] || RARITY_COLORS.commun;

    // Fond
    const grad = ctx.createLinearGradient(0, 0, 0, TEX_H);
    grad.addColorStop(0, '#201a33');
    grad.addColorStop(1, '#171325');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, TEX_W, TEX_H);

    // Illustration ou repli — sautée si la carte a un effet parallaxe actif :
    // trois calques 3D distincts viennent alors se superposer exactement au-dessus
    // de cette même zone (voir buildCardMesh), inutile de dessiner une image plate
    // en dessous qu'on ne verrait de toute façon jamais.
    const artH = 360;
    if (!hideArt) {
      const img = await loadImage(card.image);
      ctx.save();
      ctx.beginPath();
      ctx.rect(24, 24, TEX_W - 48, artH);
      ctx.clip();
      if (img) {
        const scale = Math.max((TEX_W - 48) / img.width, artH / img.height);
        const iw = img.width * scale, ih = img.height * scale;
        ctx.drawImage(img, 24 + (TEX_W - 48 - iw) / 2, 24 + (artH - ih) / 2, iw, ih);
      } else {
        const g2 = ctx.createLinearGradient(0, 24, 0, 24 + artH);
        g2.addColorStop(0, color); g2.addColorStop(1, '#171325');
        ctx.fillStyle = g2;
        ctx.fillRect(24, 24, TEX_W - 48, artH);
        ctx.fillStyle = 'rgba(255,255,255,.5)';
        ctx.font = '90px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(card.type === 'minion' ? '⚔' : '✦', TEX_W / 2, 24 + artH / 2 + 30);
      }
      ctx.restore();
    }

    // Cadre coloré par rareté
    ctx.strokeStyle = color;
    ctx.lineWidth = 6;
    ctx.strokeRect(3, 3, TEX_W - 6, TEX_H - 6);
    ctx.lineWidth = 3;
    ctx.strokeRect(24, 24, TEX_W - 48, artH);

    // Pastille de coût
    ctx.beginPath();
    ctx.arc(60, 60, 38, 0, Math.PI * 2);
    ctx.fillStyle = '#7c5cff';
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 40px "Cinzel", serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(card.cost != null ? card.cost : ''), 60, 64);
    ctx.textBaseline = 'alphabetic';

    // Nom
    ctx.fillStyle = '#ece7f7';
    ctx.font = 'bold 34px "Cinzel", serif';
    ctx.textAlign = 'center';
    wrapText(ctx, card.name, TEX_W / 2, 430, TEX_W - 60, 40);

    // Statistiques
    ctx.font = '26px sans-serif';
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.fillText(RARITY_LABELS[card.rarity] || '', TEX_W / 2, 500);

    if (card.type === 'minion') {
      ctx.font = 'bold 46px sans-serif';
      ctx.fillStyle = '#ffd166';
      ctx.textAlign = 'left';
      ctx.fillText(String(card.attack), 60, 620);
      ctx.fillStyle = '#ff5c6c';
      ctx.textAlign = 'right';
      ctx.fillText(String(card.health), TEX_W - 60, 620);
      ctx.font = '20px sans-serif';
      ctx.fillStyle = '#948da8';
      ctx.textAlign = 'left';
      ctx.fillText('ATTAQUE', 60, 645);
      ctx.textAlign = 'right';
      ctx.fillText('POINTS DE VIE', TEX_W - 60, 645);
      if (card.armor) {
        ctx.textAlign = 'center';
        ctx.fillStyle = '#8fa9d8';
        ctx.font = 'bold 24px sans-serif';
        ctx.fillText('+' + card.armor + ' armure', TEX_W / 2, 620);
      }
    } else {
      ctx.font = 'bold 40px sans-serif';
      ctx.fillStyle = '#7fd7ff';
      ctx.textAlign = 'center';
      ctx.fillText(card.effectType === 'board_wipe' ? '☠' : String(card.value != null ? card.value : ''), TEX_W / 2, 620);
    }

    // Description
    ctx.font = '18px sans-serif';
    ctx.fillStyle = '#948da8';
    ctx.textAlign = 'center';
    wrapText(ctx, card.desc || '', TEX_W / 2, 665, TEX_W - 80, 24);

    return canvas;
  }

  async function composeBackTexture(card) {
    const canvas = document.createElement('canvas');
    canvas.width = TEX_W; canvas.height = TEX_H;
    const ctx = canvas.getContext('2d');
    const img = card && card.cardBackImage ? await loadImage(card.cardBackImage) : null;
    if (img) {
      // Image de dos personnalisée (par extension), redimensionnée pour couvrir la carte
      const scale = Math.max(TEX_W / img.width, TEX_H / img.height);
      const iw = img.width * scale, ih = img.height * scale;
      ctx.drawImage(img, (TEX_W - iw) / 2, (TEX_H - ih) / 2, iw, ih);
      ctx.strokeStyle = 'rgba(255,255,255,.35)';
      ctx.lineWidth = 6;
      ctx.strokeRect(20, 20, TEX_W - 40, TEX_H - 40);
      return canvas;
    }
    // Dos par défaut si l'extension n'a pas fourni d'image : le logo Clean Gang Decks
    const grad = ctx.createLinearGradient(0, 0, TEX_W, TEX_H);
    grad.addColorStop(0, '#7c5cff'); grad.addColorStop(1, '#4a3a8f');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, TEX_W, TEX_H);
    ctx.strokeStyle = 'rgba(255,255,255,.35)';
    ctx.lineWidth = 6;
    ctx.strokeRect(20, 20, TEX_W - 40, TEX_H - 40);
    const logo = await loadImage('/branding/logo.png');
    if (logo) {
      const logoSize = TEX_W * 0.55;
      ctx.drawImage(logo, (TEX_W - logoSize) / 2, TEX_H / 2 - logoSize / 2 - 20, logoSize, logoSize);
    } else {
      ctx.fillStyle = 'rgba(255,255,255,.9)';
      ctx.font = 'bold 46px "Cinzel", serif';
      ctx.textAlign = 'center';
      ctx.fillText('✦', TEX_W / 2, TEX_H / 2 + 16);
      ctx.font = '22px "Cinzel", serif';
      ctx.fillText('CLEAN GANG DECKS', TEX_W / 2, TEX_H / 2 + 70);
    }
    return canvas;
  }

  // Zone de l'illustration en repère 3D de la carte (dérivée du rectangle
  // dessiné dans composeFrontTexture : x:24..488, y:24..384 sur une texture
  // 512×716, converti vers les dimensions réelles CARD_W×CARD_H).
  const ART_W = (TEX_W - 48) / TEX_W * CARD_W;   // ≈ 1.994
  const ART_H = 360 / TEX_H * CARD_H;            // ≈ 1.559
  const ART_CENTER_Y = CARD_H / 2 - (24 + 360 / 2) / TEX_H * CARD_H; // ≈ 0.666

  /* Compose l'image d'un calque (fond ou personnage) sur un petit canvas
     REDIMENSIONNÉ EXACTEMENT au rectangle d'illustration, en recadrant
     l'image comme un "object-fit: cover" (elle remplit tout le canvas, ce
     qui dépasse est simplement hors cadre, jamais dessiné). zoomScale > 1
     zoome encore un peu plus dans l'image avant recadrage, pour le fond.

     Pourquoi ce choix plutôt qu'un plan agrandi + découpe 3D (l'approche
     précédente, avec des THREE.Plane en tant que clipping planes) : cette
     dernière s'est révélée peu fiable en pratique (calques qui débordaient
     largement de la carte, confirmé par capture d'écran, malgré une
     vérification mathématique poussée du mécanisme). En cuisant le
     recadrage directement dans la texture, le calque ne PEUT PAS déborder
     du cadre — ce n'est plus une question de fonctionnement correct d'une
     fonctionnalité WebGL, mais une contrainte géométrique de base : le plan
     3D fait exactement la taille du cadre, ni plus ni moins. */
  async function composeParallaxLayerTexture(url, zoomScale) {
    const img = await loadImage(url);
    if (!img) return null;
    const resW = 420;
    const resH = Math.round(resW * (ART_H / ART_W));
    const canvas = document.createElement('canvas');
    canvas.width = resW; canvas.height = resH;
    const ctx = canvas.getContext('2d');
    const scale = Math.max(resW / img.width, resH / img.height) * (zoomScale || 1);
    const iw = img.width * scale, ih = img.height * scale;
    ctx.drawImage(img, (resW - iw) / 2, (resH - ih) / 2, iw, ih);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace || tex.colorSpace;
    return tex;
  }

  async function buildParallaxLayer(url, z, zoomScale) {
    const tex = await composeParallaxLayerTexture(url, zoomScale);
    if (!tex) return null;
    const mat = new THREE.MeshBasicMaterial({
      map: tex, transparent: true, depthWrite: false
      // Le personnage est un détourage (fond transparent autour de la
      // silhouette) : sans transparent:true, WebGL ignore complètement le
      // canal alpha et affiche du noir plein là où l'image devrait laisser
      // voir le fond derrière — exactement le bug remonté à l'usage. Avec
      // depthWrite:false, Three.js trie automatiquement les objets
      // transparents du plus loin au plus proche de la caméra avant de les
      // peindre : le fond (plus loin) est peint en premier, le personnage
      // (plus proche) par-dessus en se mélangeant correctement grâce à son
      // canal alpha — cet ordre de tri automatique, spécifiquement conçu
      // pour la transparence, est plus fiable ici qu'un test de profondeur
      // classique (qui ne sait pas gérer une transparence partielle).
    });
    // Taille TOUJOURS exactement celle du cadre — jamais agrandie : le zoom
    // se fait dans la texture (ci-dessus), pas en élargissant la géométrie.
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(ART_W, ART_H), mat);
    plane.position.set(0, ART_CENTER_Y, CARD_T / 2 + z);
    return plane;
  }

  /* Sans indice visuel supplémentaire, le personnage a tendance à sembler
     "flotter" au-dessus du fond plutôt que de sembler vraiment posé dedans.
     Le correctif classique pour ce genre d'effet (façon photo 3D ou
     diorama) : une ombre portée en contour, plus sombre sur les bords du
     cadre et transparente au centre. Comme les calques eux-mêmes, ce
     contour fait exactement la taille du cadre — jamais plus. */
  let vignetteTexture = null;
  function buildVignetteLayer() {
    if (!vignetteTexture) {
      const canvas = document.createElement('canvas');
      canvas.width = 256; canvas.height = 200;
      const ctx = canvas.getContext('2d');
      const g = ctx.createRadialGradient(128, 100, 60, 128, 100, 145);
      g.addColorStop(0, 'rgba(0,0,0,0)');
      g.addColorStop(0.7, 'rgba(0,0,0,0)');
      g.addColorStop(1, 'rgba(0,0,0,.65)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      vignetteTexture = new THREE.CanvasTexture(canvas);
    }
    const mat = new THREE.MeshBasicMaterial({ map: vignetteTexture, transparent: true, depthWrite: false });
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(ART_W, ART_H), mat);
    plane.position.set(0, ART_CENTER_Y, CARD_T / 2 + 0.11); // juste devant le calque personnage
    return plane;
  }

  async function buildCardMesh(card) {
    const hasParallax = !!(card.parallax && card.parallaxBackground && card.parallaxCharacter);
    const geo = new THREE.BoxGeometry(CARD_W, CARD_H, CARD_T);
    const frontCanvas = await composeFrontTexture(card, hasParallax);
    const backCanvas = await composeBackTexture(card);
    const frontTex = new THREE.CanvasTexture(frontCanvas);
    const backTex = new THREE.CanvasTexture(backCanvas);
    frontTex.colorSpace = THREE.SRGBColorSpace || frontTex.colorSpace;
    backTex.colorSpace = THREE.SRGBColorSpace || backTex.colorSpace;

    const premium = card.rarity === 'epique' || card.rarity === 'legendaire';
    const edgeColor = new THREE.Color(RARITY_COLORS[card.rarity] || '#2c2540');
    const edgeMat = new THREE.MeshStandardMaterial({
      color: edgeColor, metalness: premium ? 0.75 : 0.2, roughness: premium ? 0.25 : 0.7,
      emissive: edgeColor, emissiveIntensity: premium ? 0.35 : 0.05
    });
    const frontMat = new THREE.MeshStandardMaterial({ map: frontTex, metalness: premium ? 0.35 : 0.05, roughness: premium ? 0.35 : 0.85 });
    const backMat = new THREE.MeshStandardMaterial({ map: backTex, metalness: 0.15, roughness: 0.6 });

    // Ordre des faces BoxGeometry : +x,-x,+y,-y,+z(avant),-z(arrière)
    const mesh = new THREE.Mesh(geo, [edgeMat, edgeMat, edgeMat, edgeMat, frontMat, backMat]);
    if (!hasParallax) return mesh;

    // Empile les deux calques (fond, personnage) à des profondeurs croissantes
    // devant la carte, mais en les gardant TOUS LES DEUX proches de sa surface
    // (quelques centièmes d'unité) plutôt que de pousser le personnage loin
    // devant : un personnage qui flotte nettement plus loin que le fond donne
    // justement l'impression de "survol" qu'on cherche à éviter — pour rester
    // collé à la carte, c'est le calque le plus proche d'elle qui doit rester
    // le premier plan visible, pas celui qu'on éloigne le plus. Comme les deux
    // tournent avec la carte (enfants du même Group) mais à des distances
    // légèrement différentes de l'axe de rotation, ils se décalent l'un par
    // rapport à l'autre pendant la rotation/le glisser — combiné au cadre de
    // découpe, ce léger décalage suffit à l'impression de relief sans avoir
    // besoin d'un grand écart. Le fond est en plus rendu un peu plus grand
    // (zoomé) que le personnage : à profondeur et taille égales l'effet de
    // parallaxe est presque invisible à l'œil ; le zoom du fond accentue la
    // sensation d'un vrai arrière-plan qui s'étend au-delà du cadre.
    const group = new THREE.Group();
    group.add(mesh);
    const layers = await Promise.all([
      buildParallaxLayer(card.parallaxBackground, 0.03, 1.18),
      buildParallaxLayer(card.parallaxCharacter, 0.09, 1.0)
    ]);
    layers.forEach(plane => { if (plane) group.add(plane); });
    // Le contour d'ombre ne dépend d'aucune image de la carte (juste un
    // dégradé généré une fois et réutilisé pour toutes les cartes) — ajouté
    // uniquement si au moins un calque a pu être construit, pour ne jamais
    // l'ajouter tout seul sur une carte dont les images auraient échoué.
    if (layers.some(Boolean)) group.add(buildVignetteLayer());
    return group;
  }

  /* ---------- API publique ---------- */
  function mount(el) {
    ensureRenderer();
    container = el;
    container.innerHTML = '';
    container.appendChild(renderer.domElement);
    fitCameraToContainer();
    if (resizeObserver) resizeObserver.disconnect();
    resizeObserver = new ResizeObserver(() => fitCameraToContainer());
    resizeObserver.observe(container);
    if (!rafId) loop();
  }

  function unmount() {
    requestToken++; // annule toute composition de texture encore en cours
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    if (resizeObserver) { resizeObserver.disconnect(); resizeObserver = null; }
    clearScene();
    if (renderer && renderer.domElement.parentNode) renderer.domElement.parentNode.removeChild(renderer.domElement);
    container = null;
  }

  async function showSingle(card, el) {
    const token = ++requestToken;
    mount(el);
    clearScene();
    camera.position.z = 7; // remet la distance de caméra par défaut (peut avoir été reculée par un booster)
    const mesh = await buildCardMesh(card);
    if (token !== requestToken) { disposeMesh(mesh); return; } // une autre carte a été demandée entretemps
    mesh.position.set(0, 0, 0);
    scene.add(mesh);
    meshes = [{ mesh, autoRotate: true }];
    fitCameraToContainer();
  }

  async function showBoosterReveal(cards, el, onCardRevealed) {
    const token = ++requestToken;
    mount(el);
    clearScene();
    const gap = CARD_W + 0.5;
    const startX = -((cards.length - 1) * gap) / 2;
    const built = await Promise.all(cards.map(c => buildCardMesh(c)));
    if (token !== requestToken) { built.forEach(disposeMesh); return; }
    built.forEach((mesh, i) => {
      mesh.position.set(startX + i * gap, 0, 0);
      mesh.rotation.y = Math.PI; // face cachée au départ
      scene.add(mesh);
      meshes.push({ mesh, autoRotate: false, locked: true });
    });
    // Recul de caméra si beaucoup de cartes
    camera.position.z = 6.5 + Math.max(0, cards.length - 3) * 1.1;
    fitCameraToContainer();

    // Retournement échelonné
    meshes.forEach((m, i) => {
      setTimeout(() => {
        m.flip = { from: Math.PI, to: 0, t: 0, duration: 0.7 };
        m.locked = false;
        m.autoRotate = false;
        setTimeout(() => { if (onCardRevealed) onCardRevealed(i); }, 700);
      }, 220 * i);
    });
  }

  window.Card3D = { mount, unmount, showSingle, showBoosterReveal };
  window.dispatchEvent(new Event('card3d:ready'));

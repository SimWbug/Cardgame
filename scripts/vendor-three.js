/* Copie le build ESM de three.js (déjà présent dans node_modules après
   npm install) vers public/vendor/three/ — c'est ce fichier que le
   navigateur charge via l'importmap de public/index.html. Automatique à
   chaque npm install, pour rester synchronisé avec la version exacte de
   "three" déclarée dans package.json, sans committer ce fichier (assez
   volumineux) dans le dépôt. */
const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, '..', 'node_modules', 'three', 'build', 'three.module.min.js');
const destDir = path.join(__dirname, '..', 'public', 'vendor', 'three');
const dest = path.join(destDir, 'three.module.js');

if (!fs.existsSync(src)) {
  console.error('⚠️  node_modules/three/build/three.module.min.js introuvable — "three" est-il bien installé ?');
  process.exit(0); // on ne fait pas échouer npm install pour autant
}

fs.mkdirSync(destDir, { recursive: true });
fs.copyFileSync(src, dest);
console.log('✅ three.module.js copié vers public/vendor/three/ (visionneuse 3D des cartes).');

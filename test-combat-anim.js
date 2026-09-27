/* Teste la logique de diff qui pilote les animations de combat (dégâts,
   soin, entrée de serviteur, mort, attaque) — extraite et exécutée seule,
   sans DOM ni Three.js. */
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const src = fs.readFileSync('public/app.js', 'utf8');
// On extrait uniquement les deux fonctions concernées, sans exécuter tout le fichier
// (qui appelle boot() et suppose un vrai navigateur).
const start = src.indexOf('function emptyCombatAnim');
const end = src.indexOf('function triggerCombatAnimationCleanup');
const chunk = src.slice(start, end);
assert.ok(chunk.includes('function computeCombatAnimations'), 'la fonction doit être trouvée dans app.js');

const sandbox = { S: {} };
vm.createContext(sandbox);
vm.runInContext(chunk, sandbox);
const { computeCombatAnimations, emptyCombatAnim } = sandbox;

function mkState(id, overrides) {
  return Object.assign({
    id, status: 'active',
    you: { heroHealth: 30, board: [], weapon: null },
    opponent: { heroHealth: 30, board: [], weapon: null }
  }, overrides);
}

// 1) Premier état (pas d'état précédent) : aucune animation
sandbox.S = {};
computeCombatAnimations(null, mkState('m1'));
assert.strictEqual(sandbox.S.combatAnim.hitIds.size, 0);
console.log('✅ Aucune animation au tout premier état.');

// 2) Le héros adverse perd des PV → hit + floater
const s1 = mkState('m1');
const s2 = mkState('m1', { opponent: { heroHealth: 24, board: [] } });
computeCombatAnimations(s1, s2);
let anim = sandbox.S.combatAnim;
assert.strictEqual(anim.oppHeroHit, true);
assert.strictEqual(anim.youHeroHit, false);
const floater = anim.floaters.find(f => f.target === 'opp-hero');
assert.ok(floater && floater.amount === 6 && floater.kind === 'damage');
console.log('✅ Dégâts au héros adverse détectés (6 PV, floater correct).');

// 3) Soin du héros → heal
const s3 = mkState('m1', { you: { heroHealth: 30, board: [] } });
const s4 = mkState('m1', { you: { heroHealth: 30, board: [] } }); // pas de changement
computeCombatAnimations(mkState('m1', { you: { heroHealth: 20, board: [] } }), mkState('m1', { you: { heroHealth: 28, board: [] } }));
anim = sandbox.S.combatAnim;
assert.strictEqual(anim.youHeroHeal, true);
console.log('✅ Soin du héros détecté.');

// 4) Nouveau serviteur posé → enter
const before1 = mkState('m1', { you: { heroHealth: 30, board: [] } });
const after1 = mkState('m1', { you: { heroHealth: 30, board: [{ instanceId: 'x1', health: 3, canAttack: false, sickness: true }] } });
computeCombatAnimations(before1, after1);
anim = sandbox.S.combatAnim;
assert.ok(anim.enterIds.has('x1'));
console.log('✅ Un nouveau serviteur déclenche l\'animation d\'entrée.');

// 5) Serviteur qui perd des PV → hit (pas enter, car déjà présent)
const before2 = mkState('m1', { you: { heroHealth: 30, board: [{ instanceId: 'x1', health: 5, canAttack: true, sickness: false }] } });
const after2 = mkState('m1', { you: { heroHealth: 30, board: [{ instanceId: 'x1', health: 2, canAttack: true, sickness: false }] } });
computeCombatAnimations(before2, after2);
anim = sandbox.S.combatAnim;
assert.ok(anim.hitIds.has('x1'));
assert.ok(!anim.enterIds.has('x1'));
console.log('✅ Un serviteur existant qui perd des PV déclenche "hit", pas "enter".');

// 6) Serviteur mort → dyingMinions (avec ses données)
const before3 = mkState('m1', { opponent: { heroHealth: 30, board: [{ instanceId: 'y1', name: 'Cible', health: 1, canAttack: true, sickness: false }] } });
const after3 = mkState('m1', { opponent: { heroHealth: 30, board: [] } });
computeCombatAnimations(before3, after3);
anim = sandbox.S.combatAnim;
assert.strictEqual(anim.dyingMinions.length, 1);
assert.strictEqual(anim.dyingMinions[0].instanceId, 'y1');
assert.strictEqual(anim.dyingMinions[0].side, 'opp');
assert.strictEqual(anim.dyingMinions[0].name, 'Cible');
console.log('✅ Un serviteur disparu du plateau est capturé dans dyingMinions avec ses données.');

// 7) canAttack qui passe de true à false (hors "mal de l'invocation") → attackedIds
const before4 = mkState('m1', { you: { heroHealth: 30, board: [{ instanceId: 'z1', health: 5, canAttack: true, sickness: false }] } });
const after4 = mkState('m1', { you: { heroHealth: 30, board: [{ instanceId: 'z1', health: 5, canAttack: false, sickness: false }] } });
computeCombatAnimations(before4, after4);
anim = sandbox.S.combatAnim;
assert.ok(anim.attackedIds.has('z1'));
console.log('✅ Une carte qui vient d\'attaquer (canAttack true→false) est détectée.');

// 8) Un nouveau serviteur qui commence avec canAttack=false À CAUSE DU MAL DE L'INVOCATION
//    ne doit PAS être compté comme "attackedIds" (il vient d'apparaître, pas d'attaquer)
const before5 = mkState('m1', { you: { heroHealth: 30, board: [] } });
const after5 = mkState('m1', { you: { heroHealth: 30, board: [{ instanceId: 'w1', health: 3, canAttack: false, sickness: true }] } });
computeCombatAnimations(before5, after5);
anim = sandbox.S.combatAnim;
assert.ok(!anim.attackedIds.has('w1'), 'un serviteur qui vient d\'apparaître ne doit pas déclencher l\'animation d\'attaque');
assert.ok(anim.enterIds.has('w1'));
console.log('✅ Un serviteur fraîchement posé ne déclenche pas "attackedIds" par erreur.');

// 9) Changement de partie (id différent) → réinitialisation propre
computeCombatAnimations(mkState('ancienne-partie'), mkState('nouvelle-partie'));
anim = sandbox.S.combatAnim;
assert.strictEqual(anim.hitIds.size, 0);
assert.strictEqual(anim.dyingMinions.length, 0);
console.log('✅ Un changement de partie réinitialise proprement les animations.');

// 10) Une attaque du héros à l'arme (durabilité qui baisse sur la même arme) est détectée
const before6 = mkState('m1', { you: { heroHealth: 30, board: [], weapon: { cardId: 'w1', name: 'Lame', attack: 3, durability: 2, usesPerTurn: 1, usesThisTurn: 0 } } });
const after6 = mkState('m1', { you: { heroHealth: 30, board: [], weapon: { cardId: 'w1', name: 'Lame', attack: 3, durability: 1, usesPerTurn: 1, usesThisTurn: 1 } } });
computeCombatAnimations(before6, after6);
anim = sandbox.S.combatAnim;
assert.strictEqual(anim.youHeroAttacked, true);
assert.strictEqual(anim.oppHeroAttacked, false);
console.log('✅ Une attaque du héros à l\'arme (durabilité en baisse) est détectée.');

// 11) Remplacer une arme par une autre (cardId différent) n'est JAMAIS une attaque,
//     même si la nouvelle a moins de durabilité que l'ancienne
const before7 = mkState('m1', { you: { heroHealth: 30, board: [], weapon: { cardId: 'w1', name: 'Grande Hache', attack: 5, durability: 4, usesPerTurn: 1, usesThisTurn: 0 } } });
const after7 = mkState('m1', { you: { heroHealth: 30, board: [], weapon: { cardId: 'w2', name: 'Petit Poignard', attack: 1, durability: 1, usesPerTurn: 1, usesThisTurn: 0 } } });
computeCombatAnimations(before7, after7);
anim = sandbox.S.combatAnim;
assert.strictEqual(anim.youHeroAttacked, false, 'remplacer une arme ne doit jamais être pris pour une attaque');
console.log('✅ Remplacer une arme par une autre n\'est jamais confondu avec une attaque.');

// 12) Sans arme des deux côtés, aucune attaque de héros détectée
computeCombatAnimations(mkState('m1'), mkState('m1'));
anim = sandbox.S.combatAnim;
assert.strictEqual(anim.youHeroAttacked, false);
assert.strictEqual(anim.oppHeroAttacked, false);
console.log('✅ Sans arme équipée, aucune fausse détection d\'attaque du héros.');

console.log('\n✅ Logique de diff des animations de combat validée.');

/* Vérifie le grand écran de victoire/défaite : le résultat (victoire/
   défaite/égalité) est bien déterminé par rapport au joueur qui regarde,
   l'overlay ne se déclenche qu'à la transition vers "finished", est
   nettoyé au démarrage d'une nouvelle partie, le texte n'est pas
   sélectionnable, un bouton "Quitter" ferme l'overlay (plus de clic sur
   le fond), et les récompenses + le changement de rang s'affichent quand
   ils sont pertinents. */
const assert = require('assert');
const fs = require('fs');

const appSrc = fs.readFileSync('public/app.js', 'utf8');
const cssSrc = fs.readFileSync('public/styles.css', 'utf8');

/* 1) Le résultat est calculé relativement à state.you.slug, pas un simple booléen brut */
const resultLineIdx = appSrc.indexOf("const result = state.winner === null ? 'draw'");
assert.ok(resultLineIdx !== -1, 'le calcul du résultat doit comparer state.winner à state.you.slug');
const resultLine = appSrc.slice(resultLineIdx, resultLineIdx + 200);
assert.ok(resultLine.includes('state.you.slug'), 'la comparaison doit se faire par rapport au joueur qui regarde (state.you.slug), pas juste state.winner');
console.log('✅ Le résultat (victoire/défaite/égalité) est calculé relativement au joueur qui regarde, pas un simple champ brut.');

/* 2) Le déclenchement est bien à l'intérieur du bloc "status === finished && wasActive" (transition uniquement) */
const triggerBlockStart = appSrc.indexOf("if (state.status === 'finished' && wasActive)");
const triggerBlockEnd = appSrc.indexOf('triggerCombatAnimationCleanup();', triggerBlockStart);
const triggerBlock = appSrc.slice(triggerBlockStart, triggerBlockEnd);
assert.ok(triggerBlock.includes('S.matchResultOverlay = {'), 'l\'overlay doit être déclenché dans le bloc de transition vers "finished", pas ailleurs');
console.log('✅ L\'overlay ne se déclenche qu\'à la transition vers "finished" (pas à chaque nouvelle mise à jour de la même partie déjà terminée).');

/* 3) Le rang AVANT est capturé avant le rafraîchissement du profil (sinon rankBefore === rankAfter toujours) */
const rankBeforeIdx = triggerBlock.indexOf('const rankBefore = S.profile ? S.profile.rank : null;');
const profileRefreshIdx = triggerBlock.indexOf("S.profile = (await api('/api/me')).profile;");
assert.ok(rankBeforeIdx !== -1 && rankBeforeIdx < profileRefreshIdx, 'rankBefore doit être capturé AVANT le rafraîchissement du profil, sinon la comparaison avant/après est toujours fausse (égale à elle-même)');
console.log('✅ Le rang "avant" est bien capturé avant le rafraîchissement du profil (sinon avant == après systématiquement).');

/* 4) Nettoyage au démarrage d'une nouvelle partie */
assert.ok(appSrc.includes('if (isNewMatch) { S.matchResultOverlay = null;'), 'l\'overlay doit être nettoyé quand une nouvelle partie démarre (isNewMatch)');
console.log('✅ Un résidu d\'overlay d\'une partie précédente est bien nettoyé au démarrage d\'une nouvelle partie.');

/* 5) Nettoyage en quittant la partie */
assert.ok(appSrc.includes("leaveMatch() { S.matchState = null; S.queueStatus = 'idle'; S.matchResultOverlay = null;"), 'quitter la partie doit aussi nettoyer l\'overlay');
console.log('✅ Quitter la partie nettoie bien l\'overlay (pas de résidu visible après).');

/* 6) Auto-disparition programmée (pas un overlay bloquant indéfiniment) */
assert.ok(triggerBlock.includes('setTimeout') && triggerBlock.includes('5000'), 'l\'overlay doit disparaître automatiquement après un délai');
console.log('✅ L\'overlay disparaît automatiquement après un délai, sans bloquer l\'écran indéfiniment.');

/* 7) Un bouton "Quitter" dédié ferme l'overlay — le fond lui-même n'est plus cliquable pour fermer */
const overlayRenderStart = appSrc.indexOf('if (S.matchResultOverlay) {');
const overlayRenderEnd = appSrc.indexOf("if (S.achievementToast) {", overlayRenderStart);
const overlayRender = appSrc.slice(overlayRenderStart, overlayRenderEnd);
assert.ok(overlayRender.includes('class="btn match-result-quit" onclick="App.dismissMatchResult()">Quitter<'), 'un bouton "Quitter" dédié doit fermer l\'overlay');
assert.ok(!overlayRender.includes('match-result-overlay ${mr.result}" onclick='), 'le fond de l\'overlay ne doit plus être cliquable pour fermer (seul le bouton "Quitter" le fait)');
console.log('✅ Un bouton "Quitter" dédié ferme l\'overlay (le fond n\'est plus cliquable pour ça).');

/* 8) Le texte n'est pas sélectionnable à la souris (user-select:none sur l'overlay) */
const overlayRule = cssSrc.slice(cssSrc.indexOf('.match-result-overlay{'), cssSrc.indexOf('.match-result-text{'));
assert.ok(/user-select\s*:\s*none/.test(overlayRule), 'le texte de résultat ne doit pas être sélectionnable à la souris');
console.log('✅ Le texte "VICTOIRE"/"DÉFAITE" n\'est pas sélectionnable à la souris.');

/* 9) Chaque résultat a son propre style CSS distinct */
['win', 'lose', 'draw'].forEach(r => {
  assert.ok(cssSrc.includes(`.match-result-overlay.${r} .match-result-text{`), `un style dédié doit exister pour "${r}"`);
});
console.log('✅ Victoire, défaite et égalité ont chacune leur propre style visuel.');

/* 10) L'overlay est au-dessus du plateau de combat (z-index supérieur à .fullscreen-combat) */
const fsZ = Number((cssSrc.match(/\.fullscreen-combat\{[^}]*z-index:(\d+)/) || [])[1]);
const overlayZ = Number((cssSrc.match(/\.match-result-overlay\{[^}]*z-index:(\d+)/) || [])[1]);
assert.ok(overlayZ > fsZ, 'l\'overlay (z-index ' + overlayZ + ') doit être au-dessus du plateau de combat (z-index ' + fsZ + ')');
console.log('✅ L\'overlay s\'affiche bien AU-DESSUS du plateau de combat (' + overlayZ + ' > ' + fsZ + ').');

/* 11) Les récompenses et le changement de rang sont bien présents dans le rendu */
assert.ok(overlayRender.includes('match-result-rewards'), 'les récompenses (points, boosters, récompense du boss) doivent pouvoir s\'afficher');
assert.ok(overlayRender.includes('match-result-rank') && overlayRender.includes('rankedUp'), 'le changement de rang doit pouvoir s\'afficher, conditionné à un vrai changement');
console.log('✅ Les récompenses et le changement de rang sont bien intégrés au rendu, conditionnés à leur pertinence.');

console.log('\n✅ Grand écran de victoire/défaite (v2 : récompenses, rang, non-sélectionnable, bouton Quitter) validé.');

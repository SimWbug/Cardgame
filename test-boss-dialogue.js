/* Vérifie la logique de déclenchement des répliques du boss selon ses PV :
   le seuil le plus proche des PV actuels se déclenche (pas le premier
   trivialement satisfait), chaque seuil ne se déclenche qu'une fois par
   combat, et un gros coup qui saute plusieurs seuils n'en déclenche qu'un. */
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const src = fs.readFileSync('public/app.js', 'utf8');
const start = src.indexOf('function checkBossDialogue');
const end = src.indexOf('function computeCombatAnimations');
const chunk = src.slice(start, end);
assert.ok(chunk.includes('ascending'), 'la fonction doit être présente dans l\'extrait');

function freshSandbox() {
  const sandbox = {
    S: {
      events: { boss: { heroHealth: 100, dialogue: [
        { hpPercent: 100, text: 'Qui ose me défier ?' },
        { hpPercent: 50, text: 'Tu commences à m\'agacer.' },
        { hpPercent: 25, text: 'Impossible !' },
        { hpPercent: 0, text: '...' }
      ] } },
      bossDialogueShown: new Set(), bossDialogueActive: null
    },
    window: {}, clearTimeout: () => {}, setTimeout: (fn) => fn && 0, console
  };
  vm.createContext(sandbox);
  vm.runInContext(chunk, sandbox);
  return sandbox;
}

// 1) Au tout début (PV pleins), le seuil 100% se déclenche
let sandbox = freshSandbox();
sandbox.checkBossDialogue({ opponent: { heroHealth: 100 } });
assert.strictEqual(sandbox.S.bossDialogueActive, 'Qui ose me défier ?');
console.log('✅ À PV pleins, la réplique du seuil 100% se déclenche.');

// 2) Le boss tombe à 45% : la réplique 50% se déclenche (PAS la 100%, déjà vue)
sandbox.checkBossDialogue({ opponent: { heroHealth: 45 } });
assert.strictEqual(sandbox.S.bossDialogueActive, "Tu commences à m'agacer.", 'devrait être la réplique du seuil 50%, pas 100%');
console.log('✅ À 45% de PV, la réplique du seuil 50% se déclenche (le plus proche), pas celle à 100%.');

// 3) Rejouer le même état ne redéclenche rien (déjà vu)
sandbox.S.bossDialogueActive = null;
sandbox.checkBossDialogue({ opponent: { heroHealth: 45 } });
assert.strictEqual(sandbox.S.bossDialogueActive, null, 'un seuil déjà déclenché ne doit pas se redéclencher');
console.log('✅ Un seuil déjà déclenché ne se redéclenche pas si les PV ne bougent pas.');

// 4) Encore une baisse : le seuil 25% se déclenche
sandbox.checkBossDialogue({ opponent: { heroHealth: 20 } });
assert.strictEqual(sandbox.S.bossDialogueActive, 'Impossible !');
console.log('✅ Une nouvelle baisse déclenche le seuil suivant (25%).');

// 5) Mort du boss : le seuil 0% se déclenche
sandbox.checkBossDialogue({ opponent: { heroHealth: 0 } });
assert.strictEqual(sandbox.S.bossDialogueActive, '...');
console.log('✅ Le seuil 0% se déclenche à la mort du boss.');

// 6) Un très gros coup qui saute plusieurs seuils d'un coup n'en déclenche qu'UN SEUL
sandbox = freshSandbox();
sandbox.checkBossDialogue({ opponent: { heroHealth: 100 } }); // seuil 100%, vu
sandbox.S.bossDialogueActive = null;
sandbox.checkBossDialogue({ opponent: { heroHealth: 5 } }); // saute le seuil 50% d'un coup
// Le seuil le plus proche (le plus bas qui reste ≥ aux PV actuels) est 25%, pas 50% :
// c'est la borne la plus serrée, donc la réplique la plus pertinente à cet instant précis.
assert.strictEqual(sandbox.S.bossDialogueActive, 'Impossible !', 'le seuil 25% (le plus proche des PV actuels) doit se déclencher, pas le 50%');
console.log('✅ Un gros coup qui saute un seuil intermédiaire déclenche le seuil le plus proche des PV actuels (25%, pas 50%).');

// 7) Sans dialogue configuré, aucune erreur ni déclenchement
sandbox = freshSandbox();
sandbox.S.events.boss.dialogue = [];
assert.doesNotThrow(() => sandbox.checkBossDialogue({ opponent: { heroHealth: 50 } }));
assert.strictEqual(sandbox.S.bossDialogueActive, null);
console.log('✅ Sans dialogue configuré, aucune erreur et rien ne se déclenche.');

// 8) Sans configuration d'événement du tout (S.events null), aucune erreur
sandbox = freshSandbox();
sandbox.S.events = null;
assert.doesNotThrow(() => sandbox.checkBossDialogue({ opponent: { heroHealth: 50 } }));
console.log('✅ Sans S.events chargé, aucune erreur.');

console.log('\n✅ Logique de déclenchement des dialogues du boss validée.');

/* --- 9) Une réplique désactivée (enabled: false) est totalement ignorée --- */
sandbox = freshSandbox();
sandbox.S.events.boss.dialogue[1].enabled = false; // désactive la réplique à 50%
sandbox.checkBossDialogue({ opponent: { heroHealth: 100 } });
sandbox.S.bossDialogueActive = null;
sandbox.checkBossDialogue({ opponent: { heroHealth: 45 } });
assert.strictEqual(sandbox.S.bossDialogueActive, null, 'une réplique désactivée ne doit jamais se déclencher');
console.log('✅ Une réplique désactivée par l\'admin ne se déclenche jamais.');

/* --- 10) Les répliques restées activées continuent de fonctionner normalement --- */
sandbox.checkBossDialogue({ opponent: { heroHealth: 20 } }); // sous le seuil 25%, toujours activé
assert.strictEqual(sandbox.S.bossDialogueActive, 'Impossible !');
console.log('✅ Les répliques restées actives continuent de se déclencher normalement.');

console.log('\n✅ Activation/désactivation individuelle des répliques validée.');

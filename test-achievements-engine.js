/* Vérifie le moteur de succès en isolation : chaque type de condition,
   le déblocage (une seule fois), la récompense créditée, la progression,
   et la robustesse face à des profils/conditions incomplets. */
const assert = require('assert');
const { checkAchievements, progressFor, ensureStatsFields, emptyStats } = require('./src/achievements');

function freshUser() {
  return { slug: 'p1', collection: {}, credits: 0, dust: 0 };
}

/* --- 1. Un profil sans stats reçoit des champs par défaut sans planter --- */
let user = freshUser();
ensureStatsFields(user);
assert.deepStrictEqual(user.stats, emptyStats());
assert.deepStrictEqual(user.achievementsUnlocked, []);
console.log('✅ Un profil vierge reçoit des stats et une liste de succès vides.');

/* --- 2. cards_played_type --- */
user = freshUser();
const defCards = [{ id: 'a1', condition: { type: 'cards_played_type', param: 'minion', target: 5 }, rewardCredits: 10, rewardDust: 0 }];
ensureStatsFields(user);
user.stats.cardsPlayedByType.minion = 4;
let newly = checkAchievements(user, defCards, {});
assert.strictEqual(newly.length, 0, 'pas encore débloqué à 4/5');
user.stats.cardsPlayedByType.minion = 5;
newly = checkAchievements(user, defCards, {});
assert.strictEqual(newly.length, 1, 'débloqué à 5/5');
assert.strictEqual(user.credits, 10, 'la récompense en crédits doit être créditée');
console.log('✅ cards_played_type : déblocage et récompense corrects.');

/* --- 3. Un succès déjà débloqué ne se redéclenche jamais (même si la condition reste vraie) --- */
newly = checkAchievements(user, defCards, {});
assert.strictEqual(newly.length, 0, 'déjà débloqué, ne doit pas redonner la récompense');
assert.strictEqual(user.credits, 10, 'les crédits ne doivent pas être donnés deux fois');
console.log('✅ Un succès déjà débloqué ne se redéclenche jamais (pas de récompense en double).');

/* --- 4. card_played_specific --- */
user = freshUser();
const defSpecific = [{ id: 'a2', condition: { type: 'card_played_specific', param: 'seed-07', target: 3 }, rewardDust: 25 }];
ensureStatsFields(user);
user.stats.cardsPlayedById['seed-07'] = 2;
assert.strictEqual(checkAchievements(user, defSpecific, {}).length, 0);
user.stats.cardsPlayedById['seed-07'] = 3;
newly = checkAchievements(user, defSpecific, {});
assert.strictEqual(newly.length, 1);
assert.strictEqual(user.dust, 25);
console.log('✅ card_played_specific : suit une carte précise, récompense en poussière correcte.');

/* --- 5. defeat_opponent --- */
user = freshUser();
const defOpp = [{ id: 'a3', condition: { type: 'defeat_opponent', param: 'rival-slug', target: 2 } }];
ensureStatsFields(user);
user.stats.winsVsPlayer['rival-slug'] = 1;
user.stats.winsVsPlayer['autre-slug'] = 10; // ne doit pas compter pour ce succès précis
assert.strictEqual(checkAchievements(user, defOpp, {}).length, 0);
user.stats.winsVsPlayer['rival-slug'] = 2;
assert.strictEqual(checkAchievements(user, defOpp, {}).length, 1);
console.log('✅ defeat_opponent : ne compte que les victoires contre CE joueur précis.');

/* --- 6. reach_rank : respecte l'ordre des rangs (un rang supérieur compte) --- */
user = freshUser();
const defRank = [{ id: 'a4', condition: { type: 'reach_rank', param: 'Or', target: 1 } }];
ensureStatsFields(user);
user.stats.ranksReached = ['Bronze', 'Argent'];
assert.strictEqual(checkAchievements(user, defRank, {}).length, 0, 'Argent < Or, pas encore débloqué');
user.stats.ranksReached.push('Diamant'); // un rang AU-DESSUS d'Or doit aussi compter
newly = checkAchievements(user, defRank, {});
assert.strictEqual(newly.length, 1, 'avoir atteint Diamant (supérieur à Or) doit débloquer le succès "atteindre Or"');
console.log('✅ reach_rank : un rang supérieur au seuil compte aussi (pas besoin d\'être passé EXACTEMENT par Or).');

/* --- 7. collection_complete --- */
user = freshUser();
const pool = [
  { id: 'c1', extensionId: 'base' }, { id: 'c2', extensionId: 'base' },
  { id: 'c3', extensionId: 'ext-x' }
];
const defColl = [{ id: 'a5', condition: { type: 'collection_complete', param: 'base', target: 1 } }];
user.collection = { c1: 1 };
assert.strictEqual(checkAchievements(user, defColl, { cardPool: pool }).length, 0, 'il manque c2');
user.collection = { c1: 1, c2: 2 };
newly = checkAchievements(user, defColl, { cardPool: pool });
assert.strictEqual(newly.length, 1, 'toutes les cartes de l\'extension "base" sont possédées');
console.log('✅ collection_complete : vérifie précisément les cartes de l\'extension visée, pas tout le pool.');

/* --- 8. collection_complete avec param "all" doit couvrir TOUT le pool --- */
user = freshUser();
const defCollAll = [{ id: 'a6', condition: { type: 'collection_complete', param: 'all', target: 1 } }];
user.collection = { c1: 1, c2: 1 }; // il manque c3 (extension différente)
assert.strictEqual(checkAchievements(user, defCollAll, { cardPool: pool }).length, 0);
user.collection = { c1: 1, c2: 1, c3: 1 };
assert.strictEqual(checkAchievements(user, defCollAll, { cardPool: pool }).length, 1);
console.log('✅ collection_complete avec "all" exige bien la totalité du pool, toutes extensions confondues.');

/* --- 9. credits_spent et dust_spent --- */
user = freshUser();
const defSpend = [
  { id: 'a7', condition: { type: 'credits_spent', target: 200 } },
  { id: 'a8', condition: { type: 'dust_spent', target: 100 } }
];
ensureStatsFields(user);
user.stats.creditsSpent = 150; user.stats.dustSpent = 100;
newly = checkAchievements(user, defSpend, {});
assert.strictEqual(newly.length, 1, 'seul le succès poussière doit se débloquer (100/100), pas crédits (150/200)');
assert.strictEqual(newly[0].id, 'a8');
console.log('✅ credits_spent / dust_spent : chaque montant est suivi indépendamment.');

/* --- 10. leaderboard_top1, boss_defeats, casino_jackpots, total_wins --- */
user = freshUser();
const defMisc = [
  { id: 'a9', condition: { type: 'leaderboard_top1', target: 1 } },
  { id: 'a10', condition: { type: 'boss_defeats', target: 3 } },
  { id: 'a11', condition: { type: 'casino_jackpots', target: 2 } },
  { id: 'a12', condition: { type: 'total_wins', target: 10 } }
];
ensureStatsFields(user);
user.stats.monthlyTop1Count = 1; user.stats.bossDefeats = 3; user.stats.casinoJackpots = 1; user.stats.totalWins = 10;
newly = checkAchievements(user, defMisc, {});
assert.strictEqual(newly.map(n => n.id).sort().join(','), 'a10,a12,a9', 'seuls top1, boss et wins doivent se débloquer, pas casino (1/2)');
console.log('✅ leaderboard_top1 / boss_defeats / casino_jackpots / total_wins : chaque métrique isolée fonctionne.');

/* --- 11. Une condition invalide (type inconnu, absente) n'empêche pas les autres et ne plante pas --- */
user = freshUser();
const defMixed = [
  { id: 'bad1' }, // pas de condition du tout
  { id: 'bad2', condition: { type: 'type_qui_nexiste_pas', target: 1 } },
  { id: 'good1', condition: { type: 'total_wins', target: 1 } }
];
ensureStatsFields(user);
user.stats.totalWins = 1;
assert.doesNotThrow(() => { newly = checkAchievements(user, defMixed, {}); });
assert.strictEqual(newly.length, 1);
assert.strictEqual(newly[0].id, 'good1');
console.log('✅ Une condition invalide ou absente est ignorée sans planter et sans bloquer les autres succès.');

/* --- 12. Progression (barre de 0 à 1) --- */
user = freshUser();
ensureStatsFields(user);
user.stats.cardsPlayedByType.weapon = 3;
const p = progressFor(user, { type: 'cards_played_type', param: 'weapon', target: 10 }, {});
assert.strictEqual(p, 0.3);
const pFull = progressFor(user, { type: 'cards_played_type', param: 'weapon', target: 3 }, {});
assert.strictEqual(pFull, 1);
const pOver = progressFor(user, { type: 'cards_played_type', param: 'weapon', target: 1 }, {});
assert.strictEqual(pOver, 1, 'la progression ne doit jamais dépasser 1 même si la stat dépasse largement la cible');
console.log('✅ Progression graduelle correcte, plafonnée à 1.');

/* --- 13. Plusieurs succès se débloquent en une seule vérification si tous satisfaits d'un coup --- */
user = freshUser();
const defBatch = [
  { id: 'x1', condition: { type: 'total_wins', target: 1 } },
  { id: 'x2', condition: { type: 'total_wins', target: 1 } }
];
ensureStatsFields(user);
user.stats.totalWins = 1;
newly = checkAchievements(user, defBatch, {});
assert.strictEqual(newly.length, 2, 'les deux succès partageant la même condition doivent se débloquer ensemble');
console.log('✅ Plusieurs succès satisfaits simultanément se débloquent tous en une passe.');

console.log('\n✅ Moteur de succès validé.');

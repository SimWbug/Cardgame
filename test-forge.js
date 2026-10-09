/* Forge : ressources, construction, booster forgé, coûts réglables */
const assert = require('assert');
const fs = require('fs'), path = require('path');
try { fs.unlinkSync(path.join(__dirname, 'data', 'forge.json')); } catch (e) {}
const forge = require('./src/forge');
forge._reset();
const u = {};
forge.ensure(u);
assert.deepStrictEqual(u.resources, { bois: 0, pierre: 0, metal: 0, cristal: 0 });
assert.ok(/Construis/.test(forge.forgeBooster(u, 'base').error), 'pas de forge : pas de booster');
assert.ok(/manque/.test(forge.build(u).error), 'construction : ressources insuffisantes');
forge.add(u, { bois: 40, pierre: 30, metal: 12, cristal: 1 });
assert.ok(forge.build(u).ok && u.forge.built, 'forge construite');
assert.deepStrictEqual(u.resources, { bois: 15, pierre: 10, metal: 4, cristal: 1 }, 'coût de construction débité');
assert.ok(forge.build(u).error, 'une seule forge');
const now = 1e12;
const o1 = forge.forgeBooster(u, 'base', 'Base', now);
assert.ok(o1.ok && u.resources.bois === 9, 'commande lancée, ressources payées');
const wait = o1.order.readyAt - now;
assert.ok(wait >= 3 * 60000 && wait <= forge.MAX_WAIT_MS, 'attente entre 3 min et 1 h');
assert.ok(/pas encore/.test(forge.claim(u, o1.order.id, now + 1000).error), 'pas récupérable avant la fin');
assert.strictEqual(forge.readyToNotify(u, now + 1000).length, 0);
assert.strictEqual(forge.readyToNotify(u, o1.order.readyAt).length, 1, 'prête : à signaler');
assert.ok(forge.claim(u, o1.order.id, o1.order.readyAt).ok && u.forge.forged === 1 && u.forge.orders.length === 0, 'récupérée');
for (let i = 0; i < 400; i++) { const r = forge.rollMood(); assert.ok(r.ms > 0 && r.ms <= forge.MAX_WAIT_MS, 'jamais plus d\'une heure'); }
forge.setRecipe('base', { cost: { bois: 1, pierre: 0, metal: 0, cristal: 1 } });
assert.ok(forge.forgeBooster(u, 'base', 'Base', now).ok && u.resources.cristal === 0, 'recette modifiée par l\'admin');
forge.add(u, { bois: 10, cristal: 10 });
forge.forgeBooster(u, 'base', 'Base', now); forge.forgeBooster(u, 'base', 'Base', now);
assert.ok(/commandes/.test(forge.forgeBooster(u, 'base', 'Base', now).error), '3 commandes au maximum');
u.forge.orders = [];
u.resources.cristal = 0;
assert.ok(/cristal/.test(forge.forgeBooster(u, 'base').error), 'il manque du cristal');
forge.setRecipe('base', { enabled: false });
assert.ok(forge.forgeBooster(u, 'base').error, 'recette désactivée');
forge.setBuildCost({ bois: 'x', pierre: -5 });
assert.strictEqual(forge.buildCost().pierre, 0);
console.log("✅ Forge : ressources, construction unique, commandes avec attente (1 h max, 3 à la fois), recettes réglables par l'admin.");
// Quêtes du forgeron
const q = { slug: 'qq' }; forge.ensure(q);
const list = forge.questsOf(q, now);
assert.strictEqual(list.length, 3, '3 quêtes par jour');
assert.ok(forge.questsView(q, now).filter(x => x.type === 'deliver').length <= 2, 'au plus 2 livraisons');
assert.deepStrictEqual(forge.questsOf(q, now).map(x => x.id), list.map(x => x.id), 'mêmes quêtes toute la journée');
// forcer une quête de livraison et une de combat
q.forge.quests.list = [{ id: 'livrer-metal', progress: 0, done: false, claimed: false }, { id: 'combats', progress: 0, done: false, claimed: false }, { id: 'boss', progress: 0, done: false, claimed: false }];
assert.ok(/manque/.test(forge.questDeliver(q, 'livrer-metal', now).error));
forge.add(q, { metal: 20 });
assert.ok(forge.questDeliver(q, 'livrer-metal', now).ok && q.resources.metal === 8, 'livraison : ressources prises');
for (let i = 0; i < 4; i++) forge.questProgress(q, 'fight', 1, now);
assert.ok(!q.forge.quests.list[1].done && forge.questProgress(q, 'fight', 1, now).length === 1 && q.forge.quests.list[1].done, '5 combats : quête finie');
assert.ok(forge.questClaim(q, 'livrer-metal', now).ok && forge.questClaim(q, 'livrer-metal', now).error, 'récompense une seule fois');
assert.ok(forge.questClaim(q, 'boss', now).error, 'pas finie : pas de récompense');
const later = now + 2 * 86400000;
assert.ok(forge.questsOf(q, later).every(x => !x.done), 'nouveau jour : nouvelles quêtes');
// Cosmétiques
const cz = { slug: 'cz' }; forge.ensure(cz); cz.forge.built = true; forge.add(cz, { metal: 50, pierre: 50, bois: 50, cristal: 10 });
const oc = forge.forgeCosmetic(cz, 'c-orn-fer', () => false, now);
assert.ok(oc.ok && oc.order.kind === 'cosmetic', 'objet cosmétique en commande');
assert.ok(/déjà/.test(forge.forgeCosmetic(cz, 'c-orn-fer', () => false, now).error), 'pas deux fois le même en même temps');
assert.ok(/possèdes/.test(forge.forgeCosmetic(cz, 'c-orn-or', () => true, now).error), 'déjà possédé');
/* Admin : ornements / objets forgeables */
const ORNS = [{ id: 'none', name: 'Aucun' }, { id: 'or', name: 'Couronne Dorée' }, { id: 'forge-fer', name: 'Anneau de fer forgé' }, { id: 'orn-perso', name: 'Anneau Royal', image: '/x.png' }];
let L = forge.cosmeticsList(ORNS);
assert.ok(!L.some(c => c.refId === 'none') && L.filter(c => c.refId === 'forge-fer').length === 1, 'pas de doublon pour les ornements de forge, « Aucun » exclu');
assert.ok(L.find(c => c.id === 'c-orn:or') && !L.find(c => c.id === 'c-orn:or').enabled, 'ornement de boutique : pas forgeable par défaut');
assert.ok(L.find(c => c.id === 'c-orn-fer').enabled, 'ornement de forge : forgeable par défaut');
const cy = {}; forge.ensure(cy); forge.add(cy, { bois: 99, pierre: 99, metal: 99, cristal: 99 }); cy.forge.built = true;
assert.ok(/forge pas/.test(forge.forgeCosmetic(cy, 'c-orn:or', () => false, now, null, L).error), 'ornement non coché refusé');
forge.setCosmetic('c-orn:orn-perso', { enabled: true, cost: { metal: 7 } });
forge.setCosmetic('c-orn-fer', { enabled: false });
L = forge.cosmeticsList(ORNS);
const perso = L.find(c => c.id === 'c-orn:orn-perso');
assert.ok(perso.enabled && perso.cost.metal === 7 && perso.cost.bois === 0, 'ornement PNG rendu forgeable avec son coût');
assert.ok(/forge pas/.test(forge.forgeCosmetic(cy, 'c-orn-fer', () => false, now, null, L).error), 'ornement de forge décoché');
const op = forge.forgeCosmetic(cy, 'c-orn:orn-perso', () => false, now, null, L);
assert.ok(op.ok && op.order.cosKind === 'ornament' && op.order.refId === 'orn-perso' && cy.resources.metal === 92, 'commande d\'un ornement choisi par l\'admin');
forge.setCosmetic('c-orn-fer', { enabled: true });
console.log('✅ Forge : quêtes du forgeron (3 par jour, livraisons, progression, récompense unique) et objets cosmétiques (ornements forgeables réglés par l\'admin).');

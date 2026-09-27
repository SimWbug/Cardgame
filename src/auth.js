const bcrypt = require('bcryptjs');

function slugify(str) {
  return (str || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

async function hashPassword(pw) { return bcrypt.hash(pw, 10); }
async function verifyPassword(pw, hash) { return bcrypt.compare(pw, hash); }

function requireAuth(req, res, next) {
  if (!req.session || !req.session.userSlug) {
    return res.status(401).json({ error: 'Non connecté.' });
  }
  next();
}

module.exports = { slugify, hashPassword, verifyPassword, requireAuth };

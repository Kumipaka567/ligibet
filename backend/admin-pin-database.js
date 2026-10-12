const ADMIN_TAGS = ['R', 'G', 'S', 'V'];
const validHash = value => /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/.test(String(value || ''));

// One-time import of old settings; runtime PIN verification reads only MongoDB.
async function migratePinSettings(models, settings) {
  if (validHash(settings.ADMIN_PIN_SETUP_KEY_HASH)) {
    await models.AdminPinSettings.updateOne({ _id: 'owner' }, {
      $setOnInsert: { owner_key_hash: settings.ADMIN_PIN_SETUP_KEY_HASH, updated_at: new Date() }
    }, { upsert: true });
  }
  for (const tag of ADMIN_TAGS) {
    const hash = settings[`ADMIN_PIN_${tag}_HASH`];
    if (validHash(hash)) await models.AdminPinProfile.updateOne({ _id: tag }, {
      $setOnInsert: { pin_hash: hash, updated_at: new Date() }
    }, { upsert: true });
  }
  return Boolean((await models.AdminPinSettings.findById('owner').lean())?.owner_key_hash);
}
module.exports = { validHash, migratePinSettings };

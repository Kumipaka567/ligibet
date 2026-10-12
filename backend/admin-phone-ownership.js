function normalizePhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (/^0[17]\d{8}$/.test(digits)) return '254' + digits.slice(1);
  if (/^[17]\d{8}$/.test(digits)) return '254' + digits;
  return digits;
}
const isStaff = user => ['admin', 'superadmin'].includes(user?.role);
function phoneFor(user) {
  const phone = normalizePhone(user?.phone_number || user?.username);
  return phone.length >= 9 ? phone : '';
}
function staffPhones(users) {
  return new Set(users.filter(isStaff).flatMap(user => [phoneFor(user), normalizePhone(user.username)]).filter(phone => phone.length >= 9));
}
async function transactionOwnershipFields(models, transaction) {
  const user = await models.User.findOne({ id: transaction.user_id }).select('id username phone_number role').lean();
  const phone = normalizePhone(transaction.client_phone || phoneFor(user));
  const fields = { client_phone: phone || null, admin_tag: null, admin_tagged_by: null, admin_tagged_at: null };
  if (!phone || isStaff(user)) return fields;
  const staff = await models.User.find({ role: { $in: ['admin', 'superadmin'] } }).select('id username phone_number role').lean();
  if (staffPhones(staff).has(phone)) return fields;
  const owner = await models.AdminPhoneOwner.findById(phone).lean();
  if (owner) Object.assign(fields, { admin_tag: owner.owner_tag, admin_tagged_by: owner.admin_id || null, admin_tagged_at: owner.claimed_at });
  return fields;
}
module.exports = { normalizePhone, isStaff, phoneFor, staffPhones, transactionOwnershipFields };

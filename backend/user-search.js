function escapeSearch(value) {
  return value.replace(/[.*+?^\${}()|[\]\\]/g, '\\$&');
}

function userSearchConditions(value) {
  const search = String(value || '').trim().slice(0, 100);
  if (!search) return [];
  const conditions = [
    { username: new RegExp(escapeSearch(search), 'i') },
    { phone_number: new RegExp(escapeSearch(search), 'i') }
  ];
  if (/^[+\d\s()-]+$/.test(search)) {
    const digits = search.replace(/\D/g, '');
    if (digits) {
      const variants = new Set([digits]);
      // Local and international Kenyan forms refer to the same phone number.
      const subscriber = digits.startsWith('254') ? digits.slice(3)
        : digits.startsWith('0') ? digits.slice(1) : digits;
      if (subscriber) {
        variants.add(subscriber);
        variants.add('0' + subscriber);
        variants.add('254' + subscriber);
      }
      const phonePattern = new RegExp(Array.from(variants)
        .map(number => number.split('').join('[\\s()-]*')).join('|'), 'i');
      conditions.push({ phone_number: phonePattern }, { username: phonePattern });
    }
  }
  return conditions;
}

module.exports = { userSearchConditions };

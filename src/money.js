// phone-repair-pos/src/money.js
// Keep persisted monetary values finite, bounded, and rounded half away from
// zero. Adding EPSILON before scaling fixes binary representations such as
// 1.005 without making negative values round toward zero.
const MAX_MONEY = 999999999.99;
function money(n) {
  const value = Number(n);
  if (!Number.isFinite(value)) {
    const err = new Error('Money amount must be a finite number');
    // The same refusal src/printer.js's money() raises, and it has to carry the
    // same flag: this throw can reach POST /api/print before the renderer does,
    // when a stored amount is the broken one. The route reads the flag to answer
    // fallback:false, so a figure no paper may state is not retried on the
    // browser path instead.
    err.amountRefusal = true;
    throw err;
  }
  if (Math.abs(value) > MAX_MONEY) {
    const err = new Error(`Money amount exceeds maximum of ${MAX_MONEY}`);
    // The same flag as the throw above, because this is that guard's sibling and
    // it fires on the same rows: src/credits.js runs stored balances through
    // money() on the read path, so a figure past the cap can surface inside
    // POST /api/print's settlement render. Untagged the route reads it as a
    // printer fault, answers fallback:true, and the browser prints the very
    // figure the server refused.
    err.amountRefusal = true;
    throw err;
  }
  const [coefficient, exponent = '0'] = String(Math.abs(value)).split('e');
  const cents = Math.round(Number(`${coefficient}e${Number(exponent) + 2}`));
  const rounded = Math.sign(value) * cents / 100;
  return Object.is(rounded, -0) ? 0 : rounded;
}

module.exports = { money };

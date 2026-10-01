// Everything here is a physical wait: a service that takes 35 s to come up, a
// pool that reconnects when it reconnects. Asserting after a fixed sleep makes
// the suite a coin toss — it fails on a slow boot and passes on a fast one, and
// neither result tells you about the product. So: poll until true, or until a
// deadline that is generous enough to mean something when it expires.
const waitUntil = async (probe, { timeoutMs = 90000, everyMs = 3000 } = {}) => {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    last = await probe();
    if (last) return { ok: true, waitedMs: timeoutMs - (deadline - Date.now()) };
    if (Date.now() >= deadline) return { ok: false, waitedMs: timeoutMs };
    await new Promise((r) => setTimeout(r, everyMs));
  }
};

module.exports = { waitUntil };

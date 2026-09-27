/**
 * Minimal DOM helpers.
 *
 * `el()` builds nodes with properties and children; `text` is always assigned
 * through `textContent`, never `innerHTML`. That is not a stylistic preference:
 * task titles, AI rationales and error details are all attacker-influenced
 * strings, and this is the single boundary that guarantees none of them can
 * become markup.
 */

/**
 * @param {string} tag
 * @param {Record<string, any>} [props]
 * @param {Array<Node|string|null|false|undefined>} [children]
 */
export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = String(value);
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key in node) node[key] = value;
    else node.setAttribute(key, String(value));
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

export const $ = (selector, root = document) => root.querySelector(selector);
export const clear = (node) => {
  while (node.firstChild) node.firstChild.remove();
  return node;
};

/** Short, unambiguous date: "Mon 12 Oct". Absolute, never "in 3 days". */
export function shortDate(iso) {
  if (!iso) return '—';
  const d = new Date(`${iso}T00:00:00Z`);
  return d.toLocaleDateString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
}

export function dateRange(startIso, endIso) {
  return startIso === endIso
    ? shortDate(startIso)
    : `${shortDate(startIso)} → ${shortDate(endIso)}`;
}

export const plural = (n, word) => `${n} ${word}${Math.abs(n) === 1 ? '' : 's'}`;

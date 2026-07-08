// Fonction Spectral custom : vérifie que la MAJEURE de info.version (SemVer) correspond à la
// version portée par le base path (server url : /v1, /v2…). Une divergence (ex. info.version 2.x
// servi sous /v1) signale une rupture non répercutée sur la majeure d'URL.
// Ciblée sur la racine ($) : reçoit le document entier. Renvoie un problème par server divergent.
export default function versionMajorMatch(root) {
  if (!root || typeof root !== 'object') return;
  const version = root.info && root.info.version;
  const servers = Array.isArray(root.servers) ? root.servers : [];
  if (!version || servers.length === 0) return; // events / pas de version / pas de base path → non jugé

  const apiMajor = String(version).match(/^(\d+)/);
  if (!apiMajor) return;

  const results = [];
  servers.forEach((s, i) => {
    const url = s && s.url;
    if (typeof url !== 'string') return;
    const seg = url.match(/\/v(\d+)(?:[/.]|$)/i); // segment de version dans l'url : /v2, /v2/, /v2.1
    if (!seg) return; // pas de /vN dans le base path → non jugé
    if (seg[1] !== apiMajor[1]) {
      results.push({
        message: `Majeure de info.version (${apiMajor[1]}) ≠ version du base path (/v${seg[1]}) : ${url}`,
        path: ['servers', i, 'url'],
      });
    }
  });
  return results;
}
